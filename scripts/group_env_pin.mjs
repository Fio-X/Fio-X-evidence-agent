// Import this first in a test that is about some other feature: it drops the
// ambient group switches so the test sees the same environment whether the
// caller has them on or off. A test that needs a switch sets it after this.
//
// The hand-off and the call report have no switch any more (always on); a leftover value of the old hand-off or
// call-report variable is ignored, so no pin is needed for them.
//
// The off-table call refusal (NEWSROOM_GROUP_CALL_REFUSE and _ALL) is on unless exactly "0", so both are pinned "0" here:
// these tests are about some other feature, not about the refusal.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEWSROOM_GROUP_")) delete process.env[key];
}
process.env.NEWSROOM_GROUP_CALL_REFUSE = "0";
process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0";
