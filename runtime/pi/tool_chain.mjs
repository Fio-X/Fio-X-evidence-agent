// Deterministic tool chaining (NEWSROOM_SPEED_CHAIN_VIZ). Pure orchestration:
// the caller supplies the registered, wrapped tool executes, the phase/profile
// check and the event sink. Nothing here grants status, writes artifacts or
// skips a gate; every gate lives in the inner tool's own execute. A step that is
// not enabled, whose auto-filled parameters fail the inner schema, whose result
// does not carry the typed success field, or that reports a failure stops the
// chain. The chain never retries, repairs or overrides a model-supplied value.

const typeOk = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  null: (v) => v === null,
};

// Minimal JSON-schema check (type, enum, const, required, properties, items,
// anyOf/oneOf, min/max) over what the registered tools declare with TypeBox.
// Returns a list of error strings; empty means the value is accepted.
export function checkSchema(schema, value, path = "params") {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const options = schema.anyOf ?? schema.oneOf;
    return options.some((option) => checkSchema(option, value, path).length === 0) ? [] : [`${path} matches none of the allowed shapes`];
  }
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeOk[type]?.(value) ?? true)) return [...errors, `${path} must be of type ${types.join("|")}`];
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...checkSchema(schema.items, item, `${path}[${index}]`)));
  }
  if (typeOk.object(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...checkSchema(properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

const textOf = (result) => (result?.content ?? []).filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("\n");
const imagesOf = (result) => (result?.content ?? []).filter((block) => block?.type === "image");

export class ChainStop extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// steps: [{ name, params(state) -> object, absorb(details, state, result) -> void,
//           judge(details, state, result) -> { ok, code?, message? } }]
// call(name, params) -> the registered tool's result; enabled(name) -> boolean;
// schemaOf(name) -> JSON schema of that tool's parameters; record(event) -> void.
// The first step's own errors are thrown unchanged (a chain call fails exactly
// like the direct call would); later steps' errors are reported with everything
// the earlier steps already produced.
// signal: once aborted no further step starts; steps already produced stay.
export async function runToolChain({ steps, call, enabled, schemaOf, record = () => {}, state = {}, signal }) {
  const done = [];
  const stop = (index, code, message, extra = {}) => ({
    status: "STOPPED",
    failedAt: steps[index].name,
    code,
    message,
    nextTool: steps[index].name,
    done,
    state,
    ...extra,
  });
  const cancelled = (index, where) => stop(index, "CANCELLED", `the call was cancelled ${where}; no further step was started and the artifacts already produced were kept`);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (signal?.aborted) return cancelled(index, "before " + step.name);
    if (!enabled(step.name)) {
      return stop(index, "TOOL_NOT_ENABLED", `${step.name} is not enabled in this phase/profile; the chain stops before it and does not bypass the restriction`);
    }
    let params;
    try {
      params = step.params(state);
    } catch (error) {
      if (error instanceof ChainStop) return stop(index, error.code, error.message, error.extra);
      throw error;
    }
    const schemaErrors = checkSchema(schemaOf(step.name), params);
    if (schemaErrors.length) {
      return stop(index, "SCHEMA_REJECTED", `${step.name} parameters rejected before the call: ${schemaErrors.join("; ")}`);
    }
    await record({ phase: "start", step: index, tool: step.name, params });
    // Writing the start event is asynchronous: a cancel that arrived meanwhile
    // must stop the chain before the inner tool runs.
    if (signal?.aborted) return cancelled(index, "before " + step.name);
    let result;
    try {
      result = await call(step.name, params);
      if (result?.isError === true) throw new Error(textOf(result) || `${step.name} returned an error result`);
    } catch (error) {
      await record({ phase: "end", step: index, tool: step.name, isError: true, error: String(error?.message ?? error) });
      if (index === 0) throw error;
      return stop(index, "STEP_ERROR", String(error?.message ?? error), { error });
    }
    const details = result?.details && typeof result.details === "object" ? result.details : {};
    await record({ phase: "end", step: index, tool: step.name, isError: false, details });
    done.push({ tool: step.name, params, result, details });
    // Refs are recorded even when cancelled, so the caller sees what was produced.
    step.absorb?.(details, state, result);
    if (signal?.aborted) return { ...cancelled(index, `after ${step.name}`), nextTool: steps[index + 1]?.name ?? step.name, stoppedAfter: step.name };
    const verdict = step.judge(details, state, result);
    if (!verdict.ok) {
      return { ...stop(index, verdict.code, verdict.message ?? verdict.code), nextTool: verdict.nextTool ?? step.name, stoppedAfter: step.name };
    }
    if (verdict.after) {
      const extra = await verdict.after(done, state);
      if (signal?.aborted) return { ...cancelled(index, `after ${step.name}`), nextTool: steps[index + 1]?.name ?? step.name, stoppedAfter: step.name };
      if (extra) return { ...stop(index, extra.code, extra.message), nextTool: extra.nextTool ?? steps[index + 1]?.name ?? step.name, stoppedAfter: step.name };
    }
  }
  return { status: "COMPLETE", done, state };
}

const isTrue = (value) => value === true;

// Plan -> lint -> render -> critic. Success is read only from typed details
// fields; a missing field is a stop, never a pass.
export function vizChainSteps({ modelComputationRef, claimComputationRefs, claimBinding }) {
  // claimComputationRefs() (async) reads the verified claim record named by the plan.
  const needRef = (state, key, from) => {
    if (typeof state[key] !== "string" || !state[key]) throw new ChainStop("MISSING_FIELD", `${from} did not return ${key}; the chain cannot continue`);
    return state[key];
  };
  return [
    {
      name: "newsroom_viz_plan",
      params: (state) => state.planParams,
      absorb: (details, state) => { state.planRef = details.planRef; },
      judge: (details) => {
        if (typeof details.planRef !== "string" || !details.planRef) return { ok: false, code: "MISSING_FIELD", message: "newsroom_viz_plan returned no planRef" };
        if (!isTrue(details.publishable)) return { ok: false, code: "DRAFT", message: "the plan is a DRAFT (no verified claim_id): it is exploratory only and is not rendered by the chain", nextTool: "newsroom_viz_lint" };
        return { ok: true };
      },
    },
    {
      name: "newsroom_viz_lint",
      params: (state) => ({ plan_ref: needRef(state, "planRef", "newsroom_viz_plan") }),
      absorb: (details, state) => { state.lintRef = details.lintRef; state.computationRef = details.computationRef; },
      judge: (details, state) => {
        if (details.passed !== true) return { ok: false, code: details.passed === false ? "BLOCKED" : "MISSING_FIELD", message: details.passed === false ? "lint reported blockers" : "newsroom_viz_lint returned no passed field" };
        if (typeof details.lintRef !== "string" || !details.lintRef || typeof details.computationRef !== "string" || !details.computationRef) return { ok: false, code: "MISSING_FIELD", message: "newsroom_viz_lint returned no lintRef/computationRef" };
        return {
          ok: true,
          // Asserted after the lint step has produced the computation ref and
          // before anything is rendered: the model's own value and the claim
          // binding are checked against the verified result.
          after: async () => {
            // The model's own value must be one of the claim's computations or the
            // one the chart actually read; it is never overridden.
            if (modelComputationRef !== undefined && modelComputationRef !== state.computationRef && !(await claimComputationRefs()).includes(modelComputationRef)) {
              return { code: "CLAIM_COMPUTATION_MISMATCH", message: `computation_ref ${modelComputationRef} is neither one of the claim's computation_refs nor the computation the chart read (${state.computationRef}); it is not overridden`, nextTool: "newsroom_viz_plan" };
            }
            // The same judgement the lint just applied (claim_binding gate C): no extra,
            // no looser rule. Blocked claims already failed the lint step; this repeats
            // the identical call so the chain's verdict is the lint's by construction.
            const binding = await claimBinding(state.planRef);
            if (!binding.ok) return { code: "CLAIM_COMPUTATION_MISMATCH", message: `the claim is not bound to the chart's computation: ${binding.message}`, nextTool: "record_claim" };
            return null;
          },
        };
      },
    },
    {
      name: "newsroom_viz_render",
      params: (state) => ({ plan_ref: needRef(state, "planRef", "newsroom_viz_plan"), lint_ref: needRef(state, "lintRef", "newsroom_viz_lint") }),
      absorb: (details, state) => { state.manifestRef = details.manifestRef; },
      judge: (details) => {
        if (details.renderQaPassed !== true) return { ok: false, code: details.renderQaPassed === false ? "RENDER_QA_FAILED" : "MISSING_FIELD", message: details.renderQaPassed === false ? "render QA failed; the rejected render is kept" : "newsroom_viz_render returned no renderQaPassed field" };
        // The render re-checks the claim: a draft render is never reported as a finished chain.
        if (details.publishable === false) return { ok: false, code: "DRAFT", message: "the render is a DRAFT / not publishable at render time (the claim is no longer system-verified); the chain stops", nextTool: "newsroom_viz_plan" };
        if (typeof details.manifestRef !== "string" || !details.manifestRef) return { ok: false, code: "MISSING_FIELD", message: "newsroom_viz_render returned no manifestRef" };
        return { ok: true };
      },
    },
    {
      name: "newsroom_viz_critic",
      params: (state) => ({
        plan_ref: needRef(state, "planRef", "newsroom_viz_plan"),
        lint_ref: needRef(state, "lintRef", "newsroom_viz_lint"),
        manifest_ref: needRef(state, "manifestRef", "newsroom_viz_render"),
      }),
      absorb: (details, state) => { state.criticRef = details.criticRef; },
      judge: (details) => (details.passed === true
        ? { ok: true }
        : { ok: false, code: details.passed === false ? "REVISE" : "MISSING_FIELD", message: details.passed === false ? "the critic asks for a revision" : "newsroom_viz_critic returned no passed field" }),
    },
  ];
}

// Page chain (NEWSROOM_SPEED_CHAIN_INFOGRAPHIC): plan -> lint -> render ->
// deterministic critic -> preview. It ends at the preview: the image-aware
// vision critic is a judgment only the model can make after looking at the
// returned image, so nothing from it is ever filled in here.
// visualClaimMismatch() (async) returns a message when a visual module's
// manifest is not bound to one of that module's own claims, else null.
export function infographicChainSteps({ visualClaimMismatch }) {
  const needRef = (state, key, from) => {
    if (typeof state[key] !== "string" || !state[key]) throw new ChainStop("MISSING_FIELD", `${from} did not return ${key}; the chain cannot continue`);
    return state[key];
  };
  const missing = (tool, field) => ({ ok: false, code: "MISSING_FIELD", message: `${tool} returned no ${field}` });
  return [
    {
      name: "newsroom_infographic_plan",
      params: (state) => state.planParams,
      absorb: (details, state) => { state.planRef = details.planRef; },
      judge: (details) => {
        if (typeof details.planRef !== "string" || !details.planRef) return missing("newsroom_infographic_plan", "planRef");
        if (details.publishable === false || details.draft === true) {
          return { ok: false, code: "DRAFT", message: "the page plan is a DRAFT / not publishable and is not linted or rendered by the chain", nextTool: "newsroom_infographic_plan" };
        }
        return {
          ok: true,
          after: async () => {
            const message = await visualClaimMismatch();
            return message ? { code: "CLAIM_MANIFEST_MISMATCH", message, nextTool: "newsroom_infographic_plan" } : null;
          },
        };
      },
    },
    {
      name: "newsroom_infographic_lint",
      params: (state) => ({ plan_ref: needRef(state, "planRef", "newsroom_infographic_plan") }),
      absorb: (details, state) => { state.lintRef = details.lintRef; },
      judge: (details) => {
        if (details.passed !== true) return details.passed === false ? { ok: false, code: "BLOCKED", message: "page lint reported blockers" } : missing("newsroom_infographic_lint", "passed field");
        if (typeof details.lintRef !== "string" || !details.lintRef) return missing("newsroom_infographic_lint", "lintRef");
        return { ok: true };
      },
    },
    {
      name: "newsroom_infographic_render",
      params: (state) => ({ plan_ref: needRef(state, "planRef", "newsroom_infographic_plan"), lint_ref: needRef(state, "lintRef", "newsroom_infographic_lint") }),
      absorb: (details, state) => { state.manifestRef = details.manifestRef; },
      judge: (details) => {
        if (details.renderQaPassed !== true) return details.renderQaPassed === false ? { ok: false, code: "RENDER_QA_FAILED", message: "render QA failed; the rejected render is kept" } : missing("newsroom_infographic_render", "renderQaPassed field");
        if (typeof details.manifestRef !== "string" || !details.manifestRef) return missing("newsroom_infographic_render", "manifestRef");
        return { ok: true };
      },
    },
    {
      name: "newsroom_infographic_critic",
      params: (state) => ({
        plan_ref: needRef(state, "planRef", "newsroom_infographic_plan"),
        lint_ref: needRef(state, "lintRef", "newsroom_infographic_lint"),
        manifest_ref: needRef(state, "manifestRef", "newsroom_infographic_render"),
      }),
      absorb: (details, state) => { state.criticRef = details.criticRef; },
      judge: (details) => {
        if (details.passed !== true) return details.passed === false ? { ok: false, code: "REVISE", message: "the deterministic page critic asks for a revision" } : missing("newsroom_infographic_critic", "passed field");
        if (typeof details.criticRef !== "string" || !details.criticRef) return missing("newsroom_infographic_critic", "criticRef");
        return { ok: true };
      },
    },
    {
      name: "newsroom_infographic_preview",
      params: (state) => ({
        manifest_ref: needRef(state, "manifestRef", "newsroom_infographic_render"),
        critic_ref: needRef(state, "criticRef", "newsroom_infographic_critic"),
      }),
      absorb: (details, state) => { state.previewRef = details.previewRef; },
      judge: (details, _state, result) => {
        if (typeof details.previewRef !== "string" || !details.previewRef) return missing("newsroom_infographic_preview", "previewRef");
        // The vision step is blind without the picture: the preview must carry it.
        if (!imagesOf(result).length) return missing("newsroom_infographic_preview", "image content block");
        return { ok: true };
      },
    },
  ];
}

// Publishable comes from the steps after the plan (the render and critic read
// the claim again), never from the plan's older answer. Undefined when none of
// them reports it; true only when every reporting step says true.
function currentPublishable(done) {
  const reported = done.slice(1).map((entry) => entry.details?.publishable).filter((value) => typeof value === "boolean");
  return reported.length ? reported.every((value) => value === true) : undefined;
}

// Builds the single result the model sees: each executed step's text verbatim,
// the typed refs, and any image blocks passed through unchanged.
export function chainResultFor(outcome, { chain, textResult, handoff }) {
  const sections = outcome.done.map((entry) => `## ${entry.tool}\n${textOf(entry.result)}`);
  const refs = {};
  for (const key of ["planRef", "lintRef", "computationRef", "manifestRef", "criticRef", "previewRef"]) if (outcome.state[key]) refs[key] = outcome.state[key];
  const last = outcome.done.find((entry) => entry.tool.endsWith("_critic"))?.details ?? outcome.done.at(-1)?.details ?? {};
  const complete = outcome.status === "COMPLETE";
  const footer = complete
    ? `Chain ${chain}: COMPLETE after ${outcome.done.length} steps (${outcome.done.map((entry) => entry.tool).join(" -> ")}).${handoff ? `\n${handoff(outcome.state)}` : ""}`
    : `Chain ${chain}: STOPPED at ${outcome.failedAt} (${outcome.code}): ${outcome.message}\nCompleted steps: ${outcome.done.length ? outcome.done.map((entry) => entry.tool).join(" -> ") : "none"}. Nothing was retried, skipped or cleaned up. Call ${outcome.nextTool} separately next${outcome.code === "DRAFT" ? " after the plan has a verified claim_id" : ""}.`;
  const result = textResult([...sections, footer].join("\n\n"), {
    chain,
    chainStatus: outcome.status,
    ...(complete ? {} : { failedAt: outcome.failedAt, stopCode: outcome.code, stopMessage: outcome.message, nextTool: outcome.nextTool }),
    steps: outcome.done.map((entry) => ({ tool: entry.tool, params: entry.params, details: entry.details })),
    ...refs,
    ...(complete ? { passed: last.passed, score: last.score, publishable: currentPublishable(outcome.done) } : {}),
  });
  const images = outcome.done.flatMap((entry) => imagesOf(entry.result));
  return images.length ? { ...result, content: [...result.content, ...images] } : result;
}
