import React from "react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/utils";
import { v4 as uuidv4 } from "uuid";

export function AccountConnection() {
  const { settings, updateSettings, refreshSettings } = useSettings();

  const email: string | undefined = settings?.appAuth?.email;
  const plan: string | undefined =
    settings?.appAuth?.plan ??
    (settings?.appAuth?.featureFlags?.pro ? "Pro" : "Free");
  const status: string | undefined = settings?.appAuth?.status;
  const deviceId: string | undefined = settings?.appAuth?.deviceId;
  const isPro: boolean = settings?.appAuth?.featureFlags?.pro === true;
  const hasToken: boolean = Boolean(settings?.appAuth?.token?.value);

  const startLink = async () => {
    const state = uuidv4();
    const returnUri = encodeURIComponent("ternary://link/callback");
    const origin = "https://ternary-pre-domain.vercel.app";
    const url = `${origin}/link/start?state=${encodeURIComponent(state)}&return_uri=${returnUri}`;
    await IpcClient.getInstance().openExternalUrl(url);
  };

  const unlink = async () => {
    await updateSettings({
      appAuth: undefined,
      enableTernaryPro: false,
    });
    await refreshSettings?.();
  };

  return (
    <div
      id="account-connection"
      className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6"
    >
      <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-4">
        Account
      </h2>

      {email ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "px-2 py-1 rounded text-xs border",
                isPro
                  ? "bg-indigo-600 text-white border-indigo-500"
                  : "bg-zinc-700 text-white border-zinc-600",
              )}
              title={plan ? `Plan: ${plan}` : undefined}
            >
              {email}
            </span>
            {plan && (
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Plan: {plan}
              </span>
            )}
            {status && (
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Status: {status}
              </span>
            )}
            {deviceId && (
              <span className="text-xs text-gray-600 dark:text-gray-300">
                Device: {deviceId}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={startLink}>
              Link another device / Re-link
            </Button>
            <Button size="sm" variant="destructive" onClick={unlink}>
              Unlink this device
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="text-sm text-gray-600 dark:text-gray-300">
            Connect your app to your website account to enable Pro features
            based on your plan.
          </div>
          <Button size="sm" onClick={startLink}>
            Link Account
          </Button>
        </div>
      )}

      {hasToken && !email && (
        <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          Token saved. Waiting for account details. If not updated, click "Link
          Account" again.
        </div>
      )}
    </div>
  );
}
