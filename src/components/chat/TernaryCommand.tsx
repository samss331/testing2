import type React from "react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Terminal,
  Loader,
  CircleX,
} from "lucide-react";
import { CodeHighlight } from "./CodeHighlight";
import { CustomTagState } from "./stateTypes";

interface TernaryCommandProps {
  children?: ReactNode;
  node?: any;
  type?: string;
}

export const TernaryCommand: React.FC<TernaryCommandProps> = ({
  children,
  node,
  type: typeProp,
}) => {
  const [isContentVisible, setIsContentVisible] = useState(false);

  // Use props directly if provided, otherwise extract from node
  const type = typeProp || node?.properties?.type || "";
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  const aborted = state === "aborted";

  const getCommandLabel = () => {
    switch (type) {
      case "rebuild":
        return "Rebuild App";
      case "restart":
        return "Restart Server";
      case "refresh":
        return "Refresh Preview";
      default:
        return "Command";
    }
  };

  return (
    <div
      className={`neu-bg neu-shadow neu-radius neu-transition neu-shadow-inset px-4 py-2 border my-4 cursor-pointer ${
        inProgress
          ? "border-amber-500"
          : aborted
            ? "border-red-500"
            : "border-border"
      }`}
      onClick={() => setIsContentVisible(!isContentVisible)}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal size={16} />
          <span className="text-gray-700 dark:text-gray-300 font-medium text-sm">
            {getCommandLabel()}
          </span>
          {inProgress && (
            <div className="flex items-center text-amber-600 text-xs">
              <Loader size={14} className="mr-1 animate-spin" />
              <span>Executing...</span>
            </div>
          )}
          {aborted && (
            <div className="flex items-center text-red-600 text-xs">
              <CircleX size={14} className="mr-1" />
              <span>Did not finish</span>
            </div>
          )}
        </div>
        <div className="flex items-center">
          {isContentVisible ? (
            <ChevronsDownUp
              size={20}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            />
          ) : (
            <ChevronsUpDown
              size={20}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            />
          )}
        </div>
      </div>
      {type && (
        <div className="text-xs text-gray-500 dark:text-gray-400 font-medium mb-1">
          Command: {type}
        </div>
      )}
      <div className="text-sm text-gray-600 dark:text-gray-300">
        <span className="font-medium">Action: </span>
        Look for the action button above the chat input
      </div>
      {isContentVisible && children && (
        <div className="text-xs">
          <CodeHighlight className="language-bash">{children}</CodeHighlight>
        </div>
      )}
    </div>
  );
};
