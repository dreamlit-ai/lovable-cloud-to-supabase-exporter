declare global {
  interface DurableObjectId {}

  interface DurableObjectStub {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }

  interface DurableObjectNamespace<T = unknown> {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }

  interface DurableObjectContainerTcpPort {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }

  interface DurableObjectContainer {
    start(options: {
      enableInternet: boolean;
      env: Record<string, string>;
      hardTimeout: number;
    }): void | Promise<void>;
    monitor(): Promise<void>;
    getTcpPort(port: number): DurableObjectContainerTcpPort;
    destroy?(): Promise<void>;
  }

  interface DurableObjectState {
    storage: DurableObjectStorage;
    container?: DurableObjectContainer;
    waitUntil(promise: Promise<unknown>): void;
  }
}

export {};
