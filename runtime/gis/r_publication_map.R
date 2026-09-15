#!/usr/bin/env Rscript
suppressPackageStartupMessages({library(sf); library(ggplot2); library(ggrepel); library(jsonlite)})
args <- commandArgs(trailingOnly=TRUE)
if (length(args) < 3) stop('usage: r_publication_map.R TRACK_JSON SHORE_GEOJSON OUTPUT_SVG')
source('runtime/gis/adnplot.R')
raw <- fromJSON(args[[1]], simplifyDataFrame=TRUE)
pts <- st_as_sf(raw$points, coords=c('lon','lat'), crs=4326, remove=FALSE) |> st_transform(32635)
shore <- st_read(args[[2]], quiet=TRUE) |> st_transform(32635)
coords <- st_coordinates(pts)
track <- st_sf(geometry=st_sfc(st_linestring(coords[,1:2]), crs=32635))
p <- ggplot() +
  geom_sf(data=shore, linewidth=.45, colour='#333333') +
  geom_sf(data=track, linewidth=1.2, colour='#155f63') +
  geom_sf(data=pts, size=1.7, aes(colour=ground_speed_kt)) +
  scale_colour_viridis_c(name='knots') + coord_sf(datum=NA) +
  labs(title='A slow harbour manoeuvre, reconstructed from AIS fixes', subtitle='Syros, Greece · observed positions only') +
  adn_source_note('Source: ITSLab-UAegean/vesseltrack-tools') + adn_theme()
adn_finalise(p,args[[3]],11,7)
