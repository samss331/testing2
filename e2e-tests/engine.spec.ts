import { testSkipIfWindows } from "./helpers/test_helper";

// Device-linked Pro local flow e2e (Smart Context only)

testSkipIfWindows(
  "pro device-linked: balanced smart context",
  async ({ po }) => {
    await po.setUpDeviceLinkedPro();
    await po.sendPrompt("[dump]");

    await po.snapshotServerDump("request");
    await po.snapshotMessages({ replaceDumpPath: true });
  },
);

testSkipIfWindows(
  "pro device-linked: conservative smart context (fewer files)",
  async ({ po }) => {
    await po.setUpDeviceLinkedPro();
    const proModesDialog = await po.openProModesDialog({
      location: "home-chat-input-container",
    });
    await proModesDialog.setSmartContextMode("conservative");
    await proModesDialog.close();
    await po.sendPrompt("[dump]");

    await po.snapshotServerDump("request");
    await po.snapshotMessages({ replaceDumpPath: true });
  },
);
