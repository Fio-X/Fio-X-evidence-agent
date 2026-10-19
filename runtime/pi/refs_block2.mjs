// Local copies of preflight.mjs's candidates() and settle() (same bodies) and its MAX_SCAN: a visual-group module may not import
// them (test_group_module_calls registers cross-group imports only for newsroom.ts), and this file adds no new cross-group call.
const MAX_SCAN = 200;
const missing = (value) => value === undefined;

async function candidates(io, dir, accept) {
  let refs;
  try { refs = await io.list(dir); } catch { return { found: [], truncated: false }; }
  const truncated = refs.length > MAX_SCAN;
  const found = [];
  for (const ref of refs.slice(0, MAX_SCAN)) {
    let artifact;
    try { artifact = await io.read(ref); } catch { continue; }
    if (await accept(artifact, ref)) found.push(ref);
  }
  return { found, truncated };
}

function settle(state, field, result, none) {
  if (result.truncated) state.unresolved[field] = `more than ${MAX_SCAN} artifacts to scan; supply it explicitly`;
  else if (result.found.length === 1) { state.params[field] = result.found[0]; state.filled.push(field); }
  else if (!result.found.length) state.unresolved[field] = none;
  else state.unresolved[field] = `${result.found.length} candidates (${result.found.slice(0, 4).join(", ")}${result.found.length > 4 ? ", ..." : ""}); supply the one you mean`;
}

// NEWSROOM_SPEED_REFS_BLOCK2=1: three references that one already-written record fixes are copied
// verbatim when the model leaves them out. The vision critic's deterministic_critic_ref is the one
// critic that records the given manifest_ref, its preview_ref the one preview that records that
// manifest_ref and critic; the publication QA's plan_ref is the plan_ref the named publication
// manifest records. Only an omitted (undefined) field is filled; "" and null are values the model gave.
// Every check the tools run afterwards (passed, same manifest, preview hashes, plan match) is unchanged.
export async function fillBlock2Refs(tool, params, io) {
  const state = { params: { ...params }, filled: [], unresolved: {} };
  if (tool === "newsroom_infographic_vision_critic") {
    if (missing(state.params.deterministic_critic_ref)) {
      if (missing(state.params.manifest_ref)) state.unresolved.deterministic_critic_ref = "needs manifest_ref first";
      else settle(state, "deterministic_critic_ref", await candidates(io, "infographics/critics/", (a) => a?.manifest_ref === state.params.manifest_ref), `no deterministic infographic critic is bound to ${state.params.manifest_ref}; 请先调 newsroom_infographic_critic`);
    }
    if (missing(state.params.preview_ref)) {
      if (missing(state.params.manifest_ref) || missing(state.params.deterministic_critic_ref)) state.unresolved.preview_ref = "needs manifest_ref and deterministic_critic_ref first";
      else settle(state, "preview_ref", await candidates(io, "infographics/previews/", (a) => a?.manifest_ref === state.params.manifest_ref && a?.deterministic_critic_ref === state.params.deterministic_critic_ref), `no infographic preview is bound to ${state.params.manifest_ref} and ${state.params.deterministic_critic_ref}; 请先调 newsroom_infographic_preview`);
    }
  } else if (tool === "newsroom_publication_qa" && missing(state.params.plan_ref)) {
    if (missing(state.params.manifest_ref)) state.unresolved.plan_ref = "needs manifest_ref first";
    else {
      // The tool's own loader: a moved-away or unreadable manifest refuses here exactly as it does in the tool body.
      const manifest = await io.manifest("publications", String(state.params.manifest_ref), "publications/");
      if (typeof manifest?.plan_ref === "string" && manifest.plan_ref !== "") { state.params.plan_ref = manifest.plan_ref; state.filled.push("plan_ref"); }
      else state.unresolved.plan_ref = `the publication manifest ${state.params.manifest_ref} records no plan_ref; 请先调 newsroom_publication_render`;
    }
  }
  return state;
}
