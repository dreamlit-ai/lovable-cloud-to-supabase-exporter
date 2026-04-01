export type SourceStorageDiscoveredObject = {
  fullPath: string;
  metadata: Record<string, unknown> | null;
};

export type SourceStorageObjectEnumerator = {
  exactTotalObjects: number;
  forEachBucketObjectBatch: (
    bucketId: string,
    onBatch: (input: {
      prefix: string;
      fileObjects: SourceStorageDiscoveredObject[];
    }) => Promise<void> | void,
  ) => Promise<void>;
};

type SourceStorageObjectRow = {
  objectPath: string;
  metadata: Record<string, unknown> | null;
};

type CreateSourceStorageObjectEnumeratorInput = {
  countObjects: () => Promise<number>;
  listObjects: (
    bucketId: string,
    lastObjectPath: string | null,
    limit: number,
  ) => Promise<SourceStorageObjectRow[]>;
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 2000;

const toExactTotalObjects = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Source storage object count query returned an invalid result.");
  }
  return Math.trunc(value);
};

const objectPathPrefix = (fullPath: string): string => {
  const lastSlashIndex = fullPath.lastIndexOf("/");
  return lastSlashIndex === -1 ? "" : fullPath.slice(0, lastSlashIndex + 1);
};

export const createSourceStorageObjectEnumerator = async (
  input: CreateSourceStorageObjectEnumeratorInput,
): Promise<SourceStorageObjectEnumerator> => {
  const exactTotalObjects = toExactTotalObjects(await input.countObjects());
  const pageSize = Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE));

  return {
    exactTotalObjects,
    forEachBucketObjectBatch: async (bucketId, onBatch) => {
      let lastObjectPath: string | null = null;
      let activePrefix: string | null = null;
      let batch: SourceStorageDiscoveredObject[] = [];

      const flushBatch = async () => {
        if (activePrefix === null || batch.length === 0) return;
        await onBatch({
          prefix: activePrefix,
          fileObjects: batch,
        });
        batch = [];
      };

      while (true) {
        const rows = await input.listObjects(bucketId, lastObjectPath, pageSize);
        if (rows.length === 0) {
          await flushBatch();
          return;
        }

        for (const row of rows) {
          if (!row.objectPath) {
            throw new Error("Source storage object query returned a row without object_path.");
          }

          const prefix = objectPathPrefix(row.objectPath);
          if (activePrefix === null) {
            activePrefix = prefix;
          } else if (prefix !== activePrefix) {
            await flushBatch();
            activePrefix = prefix;
          }

          batch.push({
            fullPath: row.objectPath,
            metadata: row.metadata,
          });
          lastObjectPath = row.objectPath;
        }

        if (rows.length < pageSize) {
          await flushBatch();
          return;
        }
      }
    },
  };
};
