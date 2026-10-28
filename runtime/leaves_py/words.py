"""The page's own words (dates, chrome, legend wording), one table per language: a leaf looks a word up by key and never
writes it. Topic words (names, units, the page's text) come in with the request, not from here."""
import json, os

WORDS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "words.zh.json"), encoding="utf-8"))

def word(key, **kv):
    """The word table's entry for key, its {placeholders} filled from kv."""
    return WORDS[key].format(**kv) if kv else WORDS[key]
