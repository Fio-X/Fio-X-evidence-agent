# Layered cartographic flow

`runtime/pi/geo_flow_layers.mjs` is the project contract for a linked map and
two-end Sankey view. It keeps geographic relationship arcs and accounting flow
topology as separate panels, then links them with a stable `flow_id_field`.

Each layer must declare its own `unit`, `measure_kind`, `temporal_basis`, source
URL, source note, row set and route semantics. Widths reset inside a layer. A
global legend states that `thousand b/d`, a distance-weighted logistics proxy
and `USD bn` are not cross-layer comparable. The renderer adds a transparent
wide hit twin for each route; the composite page provides hover/focus,
click-to-pin, Escape release, keyboard focus, a data table and a reduced-motion
state.

Use `scripts/test_geo_flow_layers_v20.mjs` to regenerate the deterministic
evaluation artifact. The checked sample uses frozen EIA crude-import rows,
a frozen great-circle distance table to derive a clearly labelled logistics
exposure proxy, and the existing World Bank remittance corridor estimates. The
sample's representative country anchors and abstract/geodesic arcs are
relationship encodings, not physical tanker, pipeline, vessel or money-transfer
routes. The default cartographic flow plan now uses the bundled 1:50m Natural
Earth context for more legible regional borders. Replace it with a fixed,
licence-cleared local basemap before making a city or harbour claim; the 50m
asset is still only regional context.
