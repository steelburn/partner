/**
 * Minimal ambient Chrome MV3 API surface used by this extension — strictly
 * the used surface (no @types/chrome dependency; no bundler). Types here are
 * deliberately permissive shapes, not a full Chrome typings port.
 *
 * Used by: background.ts (connectNative, storage.local, action, runtime
 * onMessage/sendMessage), content.ts (runtime.onMessage), popup.ts
 * (runtime.sendMessage, tabs.query/sendMessage).
 */

declare namespace chrome {
  namespace runtime {
    /** Present inside event handlers when an API call failed. */
    const lastError: { message: string } | undefined;

    interface MessageSender {
      id?: string;
      url?: string;
      tab?: chrome.tabs.Tab;
    }

    interface Event<TListener extends (...args: never[]) => unknown> {
      addListener(listener: TListener): void;
      removeListener(listener: TListener): void;
      hasListener(listener: TListener): boolean;
    }

    interface Port {
      name: string;
      sender?: MessageSender;
      onMessage: Event<(message: unknown) => void>;
      onDisconnect: Event<(port: Port) => void>;
      /** ArrayBuffer for native-messaging frames; object for message ports. */
      postMessage(message: ArrayBuffer | object): void;
      disconnect(): void;
    }

    const onMessage: Event<
      (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | void
    >;

    /** Open a native-messaging port to a locally registered host. */
    function connectNative(name: string): Port;
    /** Send a message to the extension's own background context. */
    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      index: number;
      windowId: number;
      active: boolean;
      url?: string;
      title?: string;
    }
    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }
    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }

  namespace action {
    interface BadgeDetails {
      text?: string;
      tabId?: number;
    }
    function setBadgeText(details: BadgeDetails): Promise<void>;
    function setBadgeBackgroundColor(
      details: { color: string | [number, number, number, number]; tabId?: number },
    ): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }
}
