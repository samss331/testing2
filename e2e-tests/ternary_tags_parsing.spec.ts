import { testSkipIfWindows } from "./helpers/test_helper";

testSkipIfWindows("ternary tags handles nested < tags", async ({ po }) => {
  await po.setUp({ autoApprove: true });
  await po.importApp("minimal");
  await po.sendPrompt("tc=ternary-write-angle");
  await po.snapshotAppFiles({ name: "angle-tags-handled" });
});
