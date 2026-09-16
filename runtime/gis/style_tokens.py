from __future__ import annotations

def design(req):
    ds=req.get('design_system') or {}
    t=dict(ds.get('tokens') or {})
    return ds,t

def tok(t,key,default): return t.get(key,default)
