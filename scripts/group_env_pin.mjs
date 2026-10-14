// Import this first in a test that is about some other feature: it drops the
// ambient group switches so the test sees the same environment whether the
// caller has them on or off. A test that needs a switch sets it after this.
//
// #64 step 1: the hand-off and the call report are on unless exactly "0", so dropping them would now turn them ON.
// These tests compare the artifact tree of their own feature switch on against off; with the two writers on, the tree
// also holds the hand-off records and the call report, which differ with every call made. So the pin names both as
// "0" (the old default). The default-on behaviour is covered by the tests of the two switches themselves.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEWSROOM_GROUP_")) delete process.env[key];
}
process.env.NEWSROOM_GROUP_HANDOFF = "0";
process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
