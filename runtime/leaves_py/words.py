"""The page's own words (dates, chrome, legend wording), one table per language: a leaf looks a word up by key and never
writes it. Topic words (names, units, the page's text) come in with the request, not from here."""
import json, os, re

WORDS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "words.zh.json"), encoding="utf-8"))

class Refused(Exception):
    """A layer that cannot print what it was asked to; run.py replies with the reason instead of a drawing (facts.Refused)."""

def word(key, **kv):
    """The word table's entry for key, its {placeholders} filled from kv; a placeholder kv leaves open refuses, so a layer
    never prints the bare template."""
    open_ = sorted(set(re.findall(r"\{(\w+)\}", WORDS[key])) - set(kv))
    if open_: raise Refused(f"the word {key} is given no {', '.join(open_)}")
    return WORDS[key].format(**kv) if kv else WORDS[key]
