// Import this first in a test that is about some other feature: it drops the
// ambient group switches so the test sees the same environment whether the
// caller has them on or off. A test that needs a switch sets it after this.
//
// #64 step 1: the hand-off and the call report are on unless exactly "0", so dropping them would now turn them ON.
// The hand-off stays at its default (on): the tests that use this pin pass with it. Only the call report is pinned
// off, because these tests compare the artifact tree of their own feature switch on against off, and the report's
// rows differ with every call made. Its default-on behaviour is covered by the call report's own tests.
//
// The off-table call refusal (NEWSROOM_GROUP_CALL_REFUSE and _ALL) is on unless exactly "0" and stops start-up when the call
// report is "0", so both are pinned "0" here too: these tests are about some other feature, not about the refusal.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEWSROOM_GROUP_")) delete process.env[key];
}
process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
process.env.NEWSROOM_GROUP_CALL_REFUSE = "0";
process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0";
