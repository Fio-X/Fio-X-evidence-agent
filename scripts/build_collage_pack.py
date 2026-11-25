"""Builds the engraving cut-out pack of the opening picture's collage renderer (runtime/illus_hero/collage): pack.bin, pack.json,
LICENSES.tsv and the two licence text copies. Run once at ingest time, never at run time (the renderer itself reads the pack with the
standard library only and does no pixel work).

Rerun:  python3 -I -B scripts/build_collage_pack.py <cutouts-dir> [out-dir]
  <cutouts-dir>: the folder of the cut-outs (index.tsv; <id>.png, an RGBA cut-out whose three colour channels are the engraving's grey and
                 whose alpha is the figure's outline), plus the Met Open Access README (LICENCE-met-openaccess-README.txt) and the CC0 1.0
                 legal code (LICENSE-CC0-1.0-legalcode.txt).
  [out-dir]:     default runtime/illus_hero/collage next to this script.
Needs Pillow, numpy and scipy (an ingest-time environment, not the run's). The output is the same on every run for the same input.

What it writes, per figure (the single full-length figures of Miguel Gamborino's street-cries series, The Metropolitan Museum of Art,
CC0; the four pieces marked unusable below are left out), in three size tiers (l, m, s: at most 480, 240 and 120 px high):
  lines: the engraving as ink over transparency (grey + alpha PNG: the grey a fixed ink, the alpha the line darkness times the outline,
         in 32 levels), so the paper between the lines is transparent and whatever lies under it (paper or the accent) shows through;
  sil:   the figure's outline, 1-bit (the paper-coloured block that hides the figures behind it is cut by it);
  cloth: the clothing, 1-bit, only for the figures in CLOTH: a hand-set polygon per figure (drawn by eye over the engraving at a 520 px
         height, the same method as the reference study's masks), minus its cuts (held baskets, scales, jugs, a hand on the chest),
         intersected with the outline (closed and its holes filled) and opened once. It starts at the shoulders and follows them, stays off the face, the hands, the
         feet and anything held. Only these figures are red_ok (may wear the accent); a figure without a hand-set mask never does. A mask
         whose top edge is one horizontal line (flat_top) stops the build. Where a polygon side runs inside the figure (a neckline, a hem over
         the feet, the edge of a held object) it has a vertex every few px along the engraved contour, and every polygon is drawn as the
         curve through its vertices (smooth), not as straight chords; the outline is closed with a round element (a bridged gap ends in an
         arc, not a zigzag). scripts/test_illus_collage.py allows no straight run over 32 px (pixels within 0.6 px of the chord) of a mask's
         edge inside the figure at the largest tier.
Shared pieces: the paper (a smooth JPEG with the vignette), the grain (a JPEG used as a mask over the whole picture) and the foot shadow
(a soft ellipse PNG), all three generated from seeded noise or geometry, no third-party material.
pack.json indexes every piece (id, figure, tier, kind, offset, len, sha256, w, h, foot_y, facing, red_ok) and every figure (its red_ok,
clothing solidity and share, and a 16x40 occupancy grid of its outline and its clothing, which the renderer uses to keep the accent
figures' clothing in view)."""
import csv
import hashlib
import io
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

UNUSABLE = {"856582_1", "856578_3", "856580_3", "856576_1"}       # cut badly (limbs lost or two figures merged)
# The clothing polygons, (x, y) at the cut-out's 520 px high view (x from its left edge), and the cuts taken out of them (held objects,
# hands). The first three are the reference study's own masks; the rest were drawn the same way and checked by eye over the engraving.
CLOTH = {
    "856581_1": dict(poly=[(48, 104), (62, 94), (88, 82), (112, 84), (120, 88), (126, 93), (132, 100), (138, 106), (144, 113), (149, 120), (152, 128), (150, 160), (142, 176), (146, 200), (147, 230), (150, 248), (160, 256), (170, 262), (172, 360), (170, 460), (148, 466), (140, 469), (130, 471), (120, 472), (110, 473), (100, 474), (90, 474), (80, 473), (70, 473), (60, 472), (50, 471), (40, 470), (28, 468), (26, 440), (25, 410), (25, 380), (26, 355), (27, 335), (28, 318), (30, 300), (33, 290), (36, 280), (38, 270), (40, 260), (42, 240), (44, 220), (46, 200), (46, 186), (44, 172), (43, 158), (43, 144), (44, 130), (46, 116)],
                     cut=[[(80, 226), (104, 232), (106, 244), (107, 256), (107, 268), (105, 280), (101, 292), (88, 297), (80, 262), (77, 250), (77, 238)]]),
    "856583_1": dict(poly=[(62, 138), (70, 131), (78, 125), (86, 119), (93, 115), (100, 112), (150, 100), (175, 98), (200, 108), (238, 150), (246, 186), (236, 200), (200, 204), (195, 218), (191, 232), (189, 246), (189, 260), (191, 274), (195, 288), (200, 302), (206, 330), (220, 530), (66, 530), (76, 330), (73, 324), (71, 312), (70, 300), (72, 288), (74, 276), (73, 264), (75, 252), (78, 240), (68, 190), (58, 160)],
                     cut=[]),
    "856584_1": dict(poly=[(100, 125), (110, 96), (140, 84), (165, 78), (190, 80), (215, 92), (236, 112), (248, 150), (255, 185), (240, 200), (250, 300), (248, 440), (236, 446), (224, 450), (212, 452), (200, 450), (188, 447), (176, 446), (164, 447), (152, 449), (140, 452), (137, 432), (134, 410), (132, 390), (132, 370), (132, 350), (131, 330), (129, 310), (128, 300), (127, 280), (125, 262), (124, 245), (124, 230), (125, 215), (108, 198)],
                     cut=[]),
    "856578_0": dict(poly=[(66, 170), (66, 152), (68, 138), (76, 130), (86, 123), (96, 115), (106, 106), (116, 99), (126, 96), (134, 100), (142, 106), (152, 110), (164, 112), (176, 112), (188, 110), (200, 106), (210, 100), (220, 95), (232, 93), (244, 96), (256, 104), (266, 114), (274, 128), (280, 144), (282, 160), (280, 176), (276, 192), (270, 200), (292, 215), (296, 250), (300, 320), (290, 420), (296, 530), (96, 530), (98, 470), (100, 420), (96, 360), (94, 330), (92, 300), (110, 240), (125, 200), (120, 185), (95, 185), (86, 170)],
                     cut=[]),
    "856587_1": dict(poly=[(55, 100), (75, 92), (130, 92), (150, 110), (175, 150), (190, 190), (180, 215), (165, 300), (178, 470), (170, 488), (150, 490), (138, 489), (128, 486), (118, 484), (108, 484), (98, 486), (88, 489), (70, 490), (40, 490), (25, 480), (42, 390), (50, 305), (40, 215), (35, 160)],
                     cut=[[(10, 240), (25, 215), (60, 205), (100, 202), (140, 205), (170, 215), (178, 240), (165, 275), (152, 290), (140, 298), (126, 304), (112, 307), (98, 308), (84, 307), (70, 305), (56, 302), (40, 298), (26, 288), (15, 270)]]),
    "856590_0": dict(poly=[(70, 135), (100, 125), (130, 128), (160, 125), (190, 140), (225, 150), (238, 180), (240, 250), (232, 290), (212, 300), (205, 340), (207, 352), (208, 364), (207, 376), (205, 388), (203, 410), (201, 430), (200, 450), (200, 480), (190, 530), (76, 530), (74, 496), (72, 484), (73, 472), (74, 460), (72, 448), (70, 436), (70, 424), (72, 412), (73, 400), (72, 388), (70, 376), (69, 364), (70, 352), (72, 340), (85, 320), (100, 300), (60, 240), (52, 229), (44, 218), (37, 208), (30, 200), (27, 188), (26, 176), (27, 166), (30, 160), (50, 150)],
                     cut=[[(15, 280), (30, 262), (70, 250), (95, 235), (118, 250), (115, 290), (105, 330), (70, 345), (30, 338), (15, 310)], [(200, 395), (215, 375), (240, 372), (258, 395), (258, 470), (245, 498), (205, 498), (198, 460), (196, 446), (195, 432), (195, 418), (197, 406)]]),
    "856586_1": dict(poly=[(40, 140), (60, 115), (72, 111), (84, 109), (95, 110), (105, 113), (115, 115), (125, 114), (135, 112), (145, 110), (155, 111), (165, 115), (175, 120), (205, 140), (225, 170), (250, 215), (255, 240), (240, 370), (230, 440), (222, 530), (62, 530), (58, 505), (40, 440), (22, 410), (12, 360), (10, 300), (14, 250), (20, 220)],
                     cut=[[(103, 304), (100, 290), (99, 276), (100, 262), (102, 248), (105, 235), (140, 225), (150, 221), (160, 218), (170, 217), (180, 218), (190, 221), (200, 225), (250, 235), (330, 255), (350, 300), (325, 345), (260, 365), (180, 368), (125, 350), (120, 342), (114, 333), (109, 322), (105, 310)]]),
    "856592_1": dict(poly=[(125, 120), (150, 105), (175, 104), (183, 100), (192, 98), (202, 97), (212, 98), (220, 101), (226, 105), (240, 115), (250, 160), (235, 210), (225, 260), (227, 276), (228, 292), (227, 308), (225, 320), (222, 332), (219, 346), (218, 360), (218, 374), (219, 388), (221, 400), (222, 410), (220, 430), (217, 455), (215, 480), (190, 492), (80, 492), (70, 420), (65, 330), (75, 300), (120, 285), (126, 274), (131, 262), (135, 251), (140, 240), (135, 170)],
                     cut=[[(98, 322), (110, 305), (140, 300), (172, 305), (180, 322), (170, 345), (140, 355), (108, 348)]]),
    "856589_1": dict(poly=[(175, 100), (210, 92), (240, 105), (248, 110), (255, 116), (261, 122), (265, 128), (275, 160), (268, 210), (255, 240), (262, 300), (278, 420), (292, 500), (165, 505), (145, 420), (135, 300), (128, 290), (130, 245), (160, 200), (170, 140)],
                     cut=[[(0, 170), (40, 150), (120, 140), (190, 140), (215, 160), (218, 200), (205, 235), (150, 248), (60, 245), (0, 215)]]),
    "856576_0": dict(poly=[(70, 135), (100, 115), (130, 105), (165, 100), (200, 110), (208, 114), (216, 119), (223, 124), (230, 130), (240, 160), (250, 200), (300, 200), (300, 330), (240, 336), (236, 350), (234, 364), (233, 378), (234, 392), (236, 406), (238, 420), (240, 434), (238, 450), (234, 458), (226, 461), (214, 462), (204, 463), (196, 466), (190, 476), (70, 476), (68, 400), (74, 340), (80, 300), (86, 260), (92, 232), (95, 230), (84, 226), (74, 222), (64, 218), (56, 214), (52, 206), (50, 196), (50, 186), (52, 176), (56, 166)],
                     cut=[[(193, 230), (196, 215), (212, 198), (258, 193), (300, 205), (302, 262), (292, 330), (252, 342), (214, 336), (208, 328), (203, 318), (200, 309), (198, 300), (194, 290), (190, 276), (188, 262), (189, 248)]],
                     fill=[[(122, 118), (132, 108), (146, 104), (160, 106), (172, 110), (182, 114), (186, 126), (182, 140), (170, 150), (150, 154), (130, 146), (122, 132)]]),
    "856591_1": dict(poly=[(140, 150), (148, 143), (156, 138), (164, 134), (172, 128), (180, 121), (188, 114), (195, 108), (230, 105), (260, 115), (290, 125), (312, 150), (315, 195), (330, 240), (330, 340), (305, 420), (310, 530), (120, 530), (130, 420), (140, 300), (140, 220), (130, 195), (125, 165)],
                     cut=[[(238, 250), (255, 222), (300, 212), (355, 225), (368, 260), (345, 300), (330, 335), (290, 345), (255, 335), (240, 300)]]),
    "856584_0": dict(poly=[(70, 145), (85, 115), (105, 100), (135, 98), (160, 105), (195, 125), (225, 235), (225, 440), (95, 445), (85, 420), (86, 404), (88, 388), (90, 372), (90, 356), (88, 342), (84, 330), (81, 316), (81, 300), (82, 284), (85, 250), (95, 190), (70, 185), (62, 165)],
                     cut=[[(150, 130), (165, 110), (200, 100), (240, 105), (265, 125), (270, 170), (255, 210), (244, 218), (232, 224), (220, 228), (208, 230), (196, 231), (184, 230), (174, 227), (162, 218), (152, 205), (148, 192), (146, 178), (145, 164), (146, 150), (148, 138)]]),
    "856583_3": dict(poly=[(5, 175), (25, 135), (50, 115), (72, 106), (132, 108), (165, 118), (185, 140), (195, 175), (197, 190), (198, 205), (197, 220), (194, 232), (191, 240), (185, 270), (160, 265), (165, 300), (168, 320), (169, 340), (167, 360), (164, 380), (161, 400), (160, 420), (135, 430), (118, 422), (113, 404), (110, 390), (107, 381), (104, 378), (100, 381), (98, 392), (97, 406), (95, 430), (65, 440), (45, 420), (45, 300), (40, 260), (20, 240), (5, 200)],
                     cut=[[(78, 100), (81, 116), (83, 132), (86, 148), (89, 164), (91, 180), (93, 198), (94, 216), (95, 234), (96, 250), (104, 252), (112, 252), (120, 251), (128, 250), (128, 232), (128, 220), (131, 208), (132, 196), (129, 184), (127, 172), (125, 160), (123, 148), (123, 136), (125, 124), (129, 112), (132, 100), (118, 98), (104, 98), (90, 99)],
                          [(83, 196), (86, 182), (94, 176), (104, 174), (114, 175), (124, 178), (132, 184), (136, 194), (136, 206), (132, 216), (124, 223), (112, 226), (100, 225), (90, 220), (84, 210)]]),
    "857973_1": dict(poly=[(80, 110), (110, 101), (117, 98), (125, 96), (133, 97), (140, 100), (156, 104), (162, 114), (166, 128), (167, 144), (166, 160), (164, 176), (162, 192), (162, 208), (170, 250), (140, 265), (150, 330), (180, 335), (200, 420), (210, 505), (196, 503), (184, 502), (172, 502), (160, 505), (152, 512), (150, 530), (40, 530), (50, 420), (60, 330), (65, 250), (60, 200), (66, 186), (30, 184), (-10, 170), (-10, 80), (30, 60), (56, 64), (64, 72), (72, 80), (80, 88), (86, 96)],
                     cut=[[(118, 272), (130, 242), (136, 234), (143, 227), (151, 221), (160, 217), (210, 205), (260, 215), (277, 245), (272, 300), (242, 332), (180, 337), (135, 322)]]),
    "856579_1": dict(poly=[(105, 105), (125, 97), (133, 94), (142, 93), (151, 94), (160, 96), (167, 98), (174, 101), (180, 105), (190, 110), (198, 116), (205, 124), (212, 132), (218, 142), (222, 152), (225, 164), (226, 176), (224, 190), (222, 202), (219, 212), (212, 216), (203, 218), (194, 220), (186, 224), (184, 236), (182, 248), (180, 262), (180, 276), (182, 290), (188, 302), (196, 312), (200, 330), (201, 360), (200, 390), (200, 420), (198, 460), (195, 505), (30, 505), (30, 470), (31, 440), (33, 400), (35, 350), (38, 300), (40, 262), (40, 240), (44, 226), (50, 216), (58, 212), (66, 216), (76, 218), (86, 217), (94, 214), (100, 208), (105, 200), (106, 190), (104, 180), (108, 172), (111, 162), (113, 152), (114, 142), (113, 132), (111, 122), (108, 112)],
                     cut=[]),
    "856576_2": dict(poly=[(0, 100), (96, 100), (102, 104), (112, 110), (122, 114), (134, 117), (146, 116), (158, 112), (168, 107), (178, 103), (200, 96), (292, 96), (292, 270), (280, 278), (270, 283), (260, 286), (250, 288), (240, 291), (232, 300), (228, 318), (224, 332), (221, 346), (220, 360), (219, 374), (219, 388), (218, 402), (216, 416), (213, 428), (209, 438), (205, 448), (193, 451), (181, 450), (170, 446), (162, 440), (156, 438), (148, 444), (136, 449), (123, 451), (110, 449), (99, 444), (94, 428), (98, 410), (101, 394), (102, 380), (101, 366), (98, 352), (94, 340), (90, 326), (84, 312), (76, 302), (66, 294), (56, 289), (46, 286), (36, 284), (26, 283), (0, 283)],
                     cut=[]),
    "856585_3": dict(poly=[(60, 90), (112, 90), (112, 96), (120, 100), (130, 104), (142, 106), (154, 106), (166, 104), (176, 100), (186, 96), (196, 92), (270, 92), (270, 230), (262, 238), (252, 242), (242, 246), (232, 250), (224, 256), (222, 268), (220, 282), (216, 296), (212, 320), (212, 396), (205, 398), (194, 402), (182, 404), (170, 402), (160, 398), (154, 396), (146, 400), (134, 404), (136, 390), (137, 376), (136, 362), (134, 348), (132, 334), (130, 320), (129, 306), (128, 292), (128, 278), (128, 264), (127, 252), (124, 242), (118, 236), (110, 232), (102, 228), (94, 222), (86, 216), (80, 214), (74, 206), (70, 198), (66, 190), (40, 190)],
                     cut=[]),
    "856584_2": dict(poly=[(10, 100), (95, 100), (100, 106), (110, 111), (120, 114), (132, 115), (144, 114), (156, 111), (166, 107), (176, 103), (186, 100), (230, 96), (250, 98), (240, 190), (222, 226), (206, 242), (200, 246), (192, 248), (184, 246), (178, 240), (170, 234), (160, 228), (150, 226), (140, 230), (132, 238), (126, 250), (124, 262), (126, 280), (132, 300), (136, 340), (138, 380), (132, 397), (122, 401), (110, 404), (98, 405), (86, 403), (76, 400), (66, 396), (40, 394), (20, 300), (10, 200)],
                     cut=[[(110, 230), (114, 222), (124, 218), (136, 218), (148, 222), (154, 230), (150, 240), (138, 246), (124, 246), (114, 240)]]),
    "857973_2": dict(poly=[(0, 90), (84, 90), (88, 100), (93, 109), (99, 116), (106, 121), (114, 124), (121, 123), (127, 120), (132, 115), (137, 109), (142, 103), (148, 97), (156, 92), (220, 88), (220, 200), (200, 240), (190, 250), (185, 396), (175, 396), (163, 401), (151, 404), (139, 405), (127, 404), (115, 401), (103, 398), (91, 396), (79, 398), (67, 400), (30, 400), (15, 240), (0, 230)],
                     cut=[[(76, 186), (82, 174), (92, 162), (102, 148), (112, 138), (124, 130), (140, 126), (156, 126), (172, 130), (186, 136), (198, 142), (210, 150), (222, 156), (240, 160), (240, 190), (222, 192), (206, 194), (190, 194), (174, 192), (160, 190), (146, 190), (132, 194), (120, 200), (108, 206), (94, 208), (82, 202)]]),
    "856590_3": dict(poly=[(-10, 80), (30, 80), (34, 96), (40, 104), (48, 114), (56, 126), (63, 138), (70, 141), (77, 131), (85, 118), (94, 106), (104, 98), (114, 96), (124, 100), (134, 104), (144, 108), (154, 112), (190, 112), (190, 258), (182, 262), (172, 266), (162, 268), (152, 270), (142, 284), (137, 298), (133, 312), (131, 326), (130, 340), (131, 354), (133, 368), (136, 382), (140, 396), (128, 402), (116, 404), (104, 404), (92, 402), (80, 399), (68, 396), (56, 392), (48, 388), (46, 372), (46, 356), (48, 340), (50, 326), (52, 312), (52, 298), (50, 284), (46, 272), (40, 262), (30, 256), (20, 252), (10, 250), (-10, 250)],
                     cut=[]),
    "856580_0": dict(poly=[(96, 230), (100, 216), (106, 212), (108, 224), (112, 236), (118, 246), (126, 255), (136, 264), (148, 274), (158, 284), (168, 292), (180, 298), (192, 302), (204, 305), (216, 306), (228, 304), (238, 300), (248, 296), (280, 296), (280, 530), (80, 530), (86, 500), (90, 470), (92, 440), (94, 410), (96, 390), (98, 370), (97, 350), (95, 330), (92, 310), (91, 290), (90, 265), (90, 240)],
                     cut=[[(58, 360), (70, 352), (84, 350), (98, 354), (104, 364), (102, 376), (94, 386), (80, 390), (66, 386), (58, 374)]]),
    "856579_0": dict(poly=[(60, 100), (110, 96), (122, 100), (132, 106), (142, 110), (154, 112), (166, 112), (178, 110), (188, 106), (198, 100), (210, 96), (270, 96), (270, 180), (262, 184), (250, 188), (238, 192), (228, 198), (224, 206), (219, 218), (215, 230), (213, 242), (212, 254), (212, 266), (213, 278), (216, 290), (220, 302), (226, 316), (232, 326), (242, 332), (256, 334), (280, 334), (280, 530), (60, 530), (60, 334), (74, 334), (88, 333), (100, 330), (110, 324), (116, 314), (120, 302), (123, 290), (124, 278), (124, 266), (123, 254), (121, 242), (119, 230), (116, 218), (112, 206), (106, 196), (98, 190), (88, 186), (76, 184), (60, 184)],
                     cut=[[(146, 212), (148, 204), (158, 198), (170, 196), (182, 196), (194, 200), (200, 210), (196, 220), (184, 226), (172, 228), (160, 227), (150, 220)]]),
    "856587_0": dict(poly=[(130, 96), (140, 96), (150, 104), (160, 110), (170, 114), (180, 116), (190, 114), (200, 108), (208, 100), (214, 90), (220, 80), (228, 72), (240, 66), (250, 50), (320, 50), (320, 420), (308, 426), (296, 427), (284, 428), (272, 428), (260, 429), (248, 430), (236, 431), (224, 433), (212, 436), (202, 440), (194, 446), (190, 456), (190, 468), (192, 480), (186, 486), (176, 489), (164, 490), (152, 488), (142, 484), (156, 484), (159, 470), (158, 452), (161, 434), (163, 416), (161, 398), (163, 380), (165, 362), (163, 344), (162, 326), (164, 308), (162, 290), (159, 272), (157, 256), (152, 242), (142, 232), (132, 228), (125, 224), (119, 219), (115, 212), (108, 206), (104, 200), (96, 196), (90, 190)],
                     cut=[[(84, 410), (85, 400), (100, 396), (115, 395), (130, 396), (145, 398), (158, 402), (162, 410), (156, 418), (140, 422), (124, 424), (108, 422), (92, 418)]]),
    "856591_2": dict(poly=[(-10, 88), (98, 88), (108, 94), (118, 98), (130, 99), (150, 98), (170, 94), (180, 90), (190, 88), (270, 88), (270, 300), (250, 300), (238, 298), (226, 296), (214, 296), (202, 298), (190, 300), (178, 300), (166, 298), (154, 296), (142, 296), (130, 298), (118, 300), (106, 302), (94, 304), (82, 304), (70, 302), (60, 302), (-10, 302)],
                     cut=[[(126, 106), (128, 92), (140, 90), (156, 92), (172, 96), (188, 100), (204, 104), (214, 112), (218, 126), (220, 140), (223, 154), (226, 168), (229, 182), (231, 196), (232, 210), (231, 224), (228, 238), (222, 250), (212, 258), (198, 262), (184, 264), (170, 262), (158, 256), (150, 246), (144, 236), (136, 244), (124, 246), (112, 244), (102, 238), (98, 226), (100, 214), (108, 206), (118, 202), (126, 190), (126, 176), (125, 162), (124, 148), (124, 134), (125, 120)]]),
    "856587_2": dict(poly=[(-10, 112), (10, 114), (20, 118), (30, 122), (42, 124), (54, 124), (66, 122), (78, 118), (88, 114), (96, 108), (100, 100), (104, 116), (108, 130), (114, 144), (122, 156), (132, 166), (144, 176), (158, 184), (172, 189), (186, 192), (200, 193), (214, 192), (228, 190), (242, 186), (256, 180), (270, 172), (285, 165), (285, 330), (240, 330), (175, 440), (166, 442), (154, 446), (142, 448), (130, 448), (118, 446), (108, 442), (100, 438), (90, 440), (80, 444), (68, 448), (56, 449), (44, 448), (32, 445), (20, 441), (8, 438), (-10, 436)],
                     cut=[[(-10, 286), (4, 284), (16, 286), (28, 290), (36, 298), (38, 310), (36, 322), (32, 334), (24, 344), (12, 348), (-10, 348)]]),
    "856582_2": dict(poly=[(-10, 205), (10, 200), (22, 194), (34, 188), (46, 184), (58, 181), (70, 179), (82, 178), (94, 178), (104, 180), (112, 184), (120, 188), (130, 192), (140, 194), (150, 192), (156, 188), (163, 184), (169, 177), (173, 169), (177, 160), (182, 152), (188, 146), (192, 140), (202, 138), (212, 140), (220, 144), (240, 150), (240, 530), (-10, 530)],
                     cut=[[(14, 332), (16, 318), (26, 310), (38, 308), (50, 312), (58, 322), (58, 336), (52, 348), (40, 354), (28, 352), (18, 344)]]),
}
# The figures that may be the hero (pack.json hero_ok), each checked by eye over the engraving at 100% of the largest tier: the red
# reaches the shoulders and the collar and covers the sleeves, the face, hair, headscarf, hands and held objects stay out, no bite at the
# neck, no straight line across the chest. Every one is red_ok with a clothing solidity of at least the renderer's hero_solidity (0.55).
HERO_OK = {"856576_0", "856576_2", "856578_0", "856579_0", "856579_1", "856581_1", "856584_1"}
TIERS = (("l", 480), ("m", 240), ("s", 120))
LEVELS = 32                 # alpha levels of a lines piece
INK = 42                    # the grey of the engraving lines
GRID = (16, 40)             # occupancy grid of a figure (columns, rows)
W, H = 1440, 560
PAPER = np.array([236, 230, 220], float)
GRAIN_OPACITY = 0.12        # the grain mask's full value; the renderer paints the grain at this opacity
MET = "https://www.metmuseum.org/art/collection/search/"
CC0 = "https://creativecommons.org/publicdomain/zero/1.0/"


def png(im):
    b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()


def jpeg(im, q):
    b = io.BytesIO(); im.save(b, "JPEG", quality=q, optimize=True, progressive=False); return b.getvalue()


def solidity(cloth, sil):
    """How much the clothing reads as one block (the reference picture's measure, at a 300 px height): the largest connected part's share of
    its bounding box, times its share of all clothing, times the clothing's share of the outline up to 0.45."""
    lab, n = ndi.label(cloth)
    if n == 0: return 0.0
    sz = ndi.sum(cloth, lab, range(1, n + 1)); big = lab == (int(np.argmax(sz)) + 1)
    ys, xs = np.nonzero(big); bb = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
    return float((big.sum() / bb) * (sz.max() / sz.sum()) * min(1.0, cloth.sum() / max(1, sil.sum()) / 0.45))


def grid_hex(mask):
    """A boolean mask as the 16x40 occupancy grid (a cell is set when over half of it is set), row-major bits packed into hex."""
    gw, gh = GRID; im = Image.fromarray((mask * 255).astype(np.uint8)).resize((gw, gh), Image.BOX)
    bits = (np.asarray(im) > 127).astype(np.uint8).ravel()
    return np.packbits(bits).tobytes().hex()


def flat_top(cl, tol=0.015, share=0.5):
    """Whether a clothing mask's top edge is one horizontal line: over `share` of its columns start within tol x its height of the commonest
    start row (scripts/test_illus_collage.py holds every red_ok mask to the same test)."""
    h = cl.shape[0]; cols = np.nonzero(cl.any(axis=0))[0]
    if len(cols) == 0: return True
    t = np.argmax(cl[:, cols], axis=0); mode = np.bincount(t).argmax()
    return float(np.mean(np.abs(t - mode) <= tol * h)) > share


def smooth(poly, step=4.0):
    """A closed hand-set polygon drawn as the centripetal Catmull-Rom curve through its vertices (the pen tool's curve: it passes through
    every vertex, so the shape is the one set by eye, without the straight chords between vertices), sampled every `step` units."""
    n = len(poly); out = []
    P = [np.array(v, float) for v in poly]
    for i in range(n):
        p0, p1, p2, p3 = P[i - 1], P[i], P[(i + 1) % n], P[(i + 2) % n]
        t0 = 0.0; t1 = t0 + max(1e-6, np.linalg.norm(p1 - p0)) ** 0.5; t2 = t1 + max(1e-6, np.linalg.norm(p2 - p1)) ** 0.5; t3 = t2 + max(1e-6, np.linalg.norm(p3 - p2)) ** 0.5
        k = max(1, int(np.ceil(np.linalg.norm(p2 - p1) / step)))
        for j in range(k):
            u = t1 + (t2 - t1) * j / k
            a1 = (t1 - u) / (t1 - t0) * p0 + (u - t0) / (t1 - t0) * p1
            a2 = (t2 - u) / (t2 - t1) * p1 + (u - t1) / (t2 - t1) * p2
            a3 = (t3 - u) / (t3 - t2) * p2 + (u - t2) / (t3 - t2) * p3
            b1 = (t2 - u) / (t2 - t0) * a1 + (u - t0) / (t2 - t0) * a2
            b2 = (t3 - u) / (t3 - t1) * a2 + (u - t1) / (t3 - t1) * a3
            c = (t2 - u) / (t2 - t1) * b1 + (u - t1) / (t2 - t1) * b2
            out.append((round(float(c[0]), 3), round(float(c[1]), 3)))
    return out


def cloth_mask(pid, a):
    """The clothing of one figure from its hand-set polygon (CLOTH; a: the cut-out's alpha): the polygon minus its cuts, inside the outline
    (closed, its holes filled), opened once; None for a figure without one."""
    v = CLOTH.get(pid[len("met_gam_"):])
    if v is None: return None
    h, w = a.shape; s = h / 520.0
    m = Image.new("L", (w, h), 0); d = ImageDraw.Draw(m)
    d.polygon([(x * s, y * s) for x, y in smooth(v["poly"])], fill=255)
    for c in v["cut"]: d.polygon([(x * s, y * s) for x, y in smooth(c)], fill=0)
    pm = np.asarray(m) > 127
    it = max(4, h // 40)                 # padded first: a closing eats `it` px off any part of the figure that touches the image edge
    yy, xx = np.mgrid[-it:it + 1, -it:it + 1]; disk = xx * xx + yy * yy <= it * it   # a round element: where it bridges a gap the edge is an arc, not a diamond's zigzag
    body = ndi.binary_fill_holes(ndi.binary_closing(np.pad(a > 0.5, it), structure=disk))[it:-it, it:-it]
    cl = pm & body                       # the light parts of a garment the cut left open (inside or at its edge) are still the garment: no holes
    if v.get("fill"):                   # light cloth the outline lost (a dotted shawl at the neck): hand-set, added whole
        f = Image.new("L", (w, h), 0); df = ImageDraw.Draw(f)
        for c in v["fill"]: df.polygon([(x * s, y * s) for x, y in smooth(c)], fill=255)
        cl = cl | (np.asarray(f) > 127)
    cl = ndi.binary_opening(cl, iterations=1)
    if flat_top(cl): raise SystemExit(f"{pid}: the clothing polygon's top edge is one horizontal line")
    return cl


def figure_pieces(src, pid):
    """The pieces of one figure in its three tiers, and its figure entry (red_ok: it has a hand-set clothing mask, CLOTH)."""
    im = Image.open(os.path.join(src, f"{pid}.png")).convert("RGBA")
    full = cloth_mask(pid, np.asarray(im.getchannel("A")) / 255.0)
    cm = Image.fromarray((full * 255).astype(np.uint8)) if full is not None else None
    out = []; info = {}
    for tier, cap in TIERS:
        h = min(cap, im.height); w = max(1, round(im.width * h / im.height))
        r = im.resize((w, h), Image.LANCZOS)
        g = np.asarray(r.getchannel("R")) / 255.0; a = np.asarray(r.getchannel("A")) / 255.0
        al = np.round(np.clip((1 - g) * a, 0, 1) * (LEVELS - 1)) / (LEVELS - 1)
        lines = Image.fromarray(np.stack([np.full(al.shape, INK, np.uint8), (al * 255).round().astype(np.uint8)], -1), "LA")
        sil = a > 0.5
        if tier == "l":
            cloth = np.asarray(cm.resize((w, h), Image.LANCZOS)) > 127 if cm is not None else np.zeros_like(sil)     # not cut by sil: its filled holes stay
            big_cloth = cloth
            share = float(cloth.sum() / max(1, sil.sum()))
            s300 = 300 / h
            sz = (max(1, round(w * s300)), 300)
            sil300 = np.asarray(Image.fromarray((sil * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            cl300 = np.asarray(Image.fromarray((cloth * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            sol = solidity(cl300, sil300)
            red_ok = cm is not None
            info = dict(solidity=round(sol, 4), cloth_share=round(share, 4), usable=True, red_ok=red_ok,
                        grid={"w": GRID[0], "h": GRID[1], "sil": grid_hex(sil), "cloth": grid_hex(cloth)})
        else:
            cloth = np.asarray(Image.fromarray((big_cloth * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)) > 127
        rows = np.nonzero(sil.any(axis=1))[0]; foot = int(rows.max()) if len(rows) else h - 1
        out.append((tier, "lines", png(lines), w, h, foot))
        out.append((tier, "sil", png(Image.fromarray((sil * 255).astype(np.uint8)).convert("1")), w, h, foot))
        if info["red_ok"]: out.append((tier, "cloth", png(Image.fromarray((cloth * 255).astype(np.uint8)).convert("1")), w, h, foot))
    return out, info


def shared_pieces():
    """The paper, the grain and the foot shadow: seeded noise and geometry (the reference picture's paper tone, vignette, lower shade and grain)."""
    rng = np.random.default_rng(2)
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.06 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    v = v * (1 - 0.05 * np.clip((yy - 200) / 350, 0, 1))
    blob = ndi.gaussian_filter(rng.normal(0, 1, (H, W)), 2.5); blob = blob / blob.std()
    base = PAPER[None, None, :] * v[..., None] + (0.25 * 7.0 * blob)[..., None]
    base = base / (1 - 0.035)                       # the grain darkens by 0.035 on average; the paper under it is that much lighter
    paper = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).resize((W // 2, H // 2), Image.LANCZOS)
    fine = ndi.gaussian_filter(rng.normal(0, 1, (H // 2, W // 2)), 0.6); fine = fine / fine.std()
    a = np.clip(0.035 + 0.027 * fine, 0, GRAIN_OPACITY)
    grain = Image.fromarray((a / GRAIN_OPACITY * 255).round().astype(np.uint8), "L")
    sw, sh = 64, 12
    ys, xs = np.mgrid[0:sh * 2, 0:sw * 2]
    shd = np.clip(1 - (((xs + 0.5 - sw) / sw) ** 2 + ((ys + 0.5 - sh) / sh) ** 2), 0, 1) * 0.26
    shadow = Image.fromarray(np.stack([np.zeros(shd.shape, np.uint8), (shd * 255).round().astype(np.uint8)], -1), "LA")
    return [("paper", jpeg(paper, 82), W // 2, H // 2), ("grain", jpeg(grain, 80), W // 2, H // 2), ("shadow", png(shadow), sw * 2, sh * 2)]


def main():
    if len(sys.argv) < 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: python3 -I -B scripts/build_collage_pack.py <cutouts-dir> [out-dir]  (the cut-outs folder is required)")
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "illus_hero", "collage")
    os.makedirs(out_dir, exist_ok=True)
    rows = [r for r in csv.DictReader(open(os.path.join(src, "index.tsv"), encoding="utf-8"), delimiter="\t")
            if r["id"].startswith("met_gam_") and r["id"][len("met_gam_"):] not in UNUSABLE]
    rows.sort(key=lambda r: r["id"])
    missing = sorted((set(CLOTH) | HERO_OK) - {r["id"][len("met_gam_"):] for r in rows})
    if missing: sys.exit(f"clothing polygons for figures not in the pack: {missing}")
    blob = bytearray(); pieces = []; figures = []

    def add(pid, figure, tier, kind, data, w, h, foot, facing, red_ok):
        pieces.append(dict(id=pid, figure=figure, tier=tier, kind=kind, offset=len(blob), len=len(data), sha256=hashlib.sha256(data).hexdigest(),
                           w=w, h=h, foot_y=foot, facing=facing, red_ok=red_ok))
        blob.extend(data)

    for kind, data, w, h in shared_pieces(): add(kind, None, None, kind, data, w, h, None, None, False)
    for r in rows:
        ps, info = figure_pieces(src, r["id"])
        facing = r.get("facing") or "n/a"
        hero_ok = r["id"][len("met_gam_"):] in HERO_OK
        if hero_ok and not (info["red_ok"] and info["solidity"] >= 0.55): sys.exit(f"{r['id']}: on the hero list but not red_ok with solidity >= 0.55")
        figures.append(dict(id=r["id"], facing=facing, red_ok=info["red_ok"], hero_ok=hero_ok, usable=info["usable"], solidity=info["solidity"],
                            cloth_share=info["cloth_share"], grid=info["grid"]))
        for tier, kind, data, w, h, foot in ps: add(f"{r['id']}.{tier}.{kind}", r["id"], tier, kind, data, w, h, foot, facing, info["red_ok"])
    data = bytes(blob)
    open(os.path.join(out_dir, "pack.bin"), "wb").write(data)
    index = dict(version=1, set="gamborino", doc="Index of pack.bin (built by scripts/build_collage_pack.py; see its header). Each piece is a PNG or JPEG at "
                 "[offset, offset+len) of pack.bin; tiers l, m, s are at most 480, 240, 120 px high; lines = ink over transparency, sil = the outline (1 bit), "
                 "cloth = the clothing (1 bit). The grain is a mask painted at grain_opacity.",
                 bin_bytes=len(data), bin_sha256=hashlib.sha256(data).hexdigest(), tiers={t: c for t, c in TIERS}, ink=INK, grain_opacity=GRAIN_OPACITY,
                 paper="#f5eee4", figures=figures, pieces=pieces)
    text = json.dumps(index, separators=(",", ":")).replace('},{"id"', '},\n{"id"')      # one figure or piece per line
    open(os.path.join(out_dir, "pack.json"), "w", encoding="utf-8").write(text + "\n")
    with open(os.path.join(out_dir, "LICENSES.tsv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, delimiter="\t", lineterminator="\n")
        wr.writerow(["id", "museum", "object_id", "accession", "author", "date", "licence_url", "source_url", "notes"])
        for r in rows:
            wr.writerow([r["id"], r["museum"], r["object_id"], r["accession"], r["author"], r["date"], CC0, MET + r["object_id"],
                         "single figure cut from the museum's Open Access image (isPublicDomain=true); text of the terms: LICENCE-met-openaccess-README.txt, LICENSE-CC0-1.0-legalcode.txt"])
        for kind in ("paper", "grain", "shadow"):
            wr.writerow([kind, "-", "-", "-", "-", "-", CC0, "-", "generated by scripts/build_collage_pack.py (seeded noise or geometry); no third-party material"])
    for name in ("LICENCE-met-openaccess-README.txt", "LICENSE-CC0-1.0-legalcode.txt"):
        shutil.copyfile(os.path.join(src, name), os.path.join(out_dir, name))
    by_kind = {}
    for p in pieces: by_kind[p["kind"]] = by_kind.get(p["kind"], 0) + p["len"]
    print(f"figures {len(figures)}  red_ok {sum(f['red_ok'] for f in figures)}  usable {sum(f['usable'] for f in figures)}")
    print(f"pack.bin {len(data)} B  largest piece {max(p['len'] for p in pieces)} B  by kind {by_kind}")
    print(f"pack.json {os.path.getsize(os.path.join(out_dir, 'pack.json'))} B")


if __name__ == "__main__":
    main()
