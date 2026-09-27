#!/usr/bin/env python3
import json
from pathlib import Path
import jsonschema
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/map-spec.schema.json').read_text())
jsonschema.Draft202012Validator.check_schema(schema)
asset={'content_hash':'a'*64,'source_url':'https://example.invalid/gshhg','license':'test fixture','extent':{'west':105,'east':115,'south':-10,'north':0},'detail_class':'intermediate','features':[]}
spec={'schema_version':'0.2.0','projection':'equirectangular','crs':'EPSG:4326','task':'local','style_intent':'nature_scientific_map','extent':asset['extent'],'basemap_asset':asset,'scale':{'enabled':True,'unit':'km','length_km':100},'layers':[{'id':'obs','type':'observations'}]}
jsonschema.Draft202012Validator(schema).validate(spec)
bad=dict(spec); bad['basemap_id']='naturalearth-admin0-110m'
try: jsonschema.Draft202012Validator(schema).validate(bad)
except jsonschema.ValidationError: pass
else: raise SystemExit('v0.2 must select exactly one basemap source')
print('MapSpec 0.2 schema PASS')
