// Import this first in a test that is about some other feature: it drops the
// ambient group switches so the test sees the same environment whether the
// caller has them on or off. A test that needs a switch sets it after this.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("NEWSROOM_GROUP_")) delete process.env[key];
}
