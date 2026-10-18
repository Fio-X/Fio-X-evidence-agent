// Import this first in a test that is about some other feature and plans a ROUTE_SPINE page on a model-reported verified_locations.
// NEWSROOM_VERIFIED_LOCATIONS_BACKED is on unless exactly "0" (the report is dropped unless program-written location evidence backs it), so it is
// pinned "0" here: these tests are about something else. scripts/test_verified_locations_backed.mjs is the test for the default.
process.env.NEWSROOM_VERIFIED_LOCATIONS_BACKED = "0";
