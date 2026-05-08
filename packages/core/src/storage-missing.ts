export type StorageMissingObject = {
  bucketId: string;
  objectPath: string;
  projectHost: string;
  projectRole: "source";
  statusCode: number;
  reason: "source_object_not_found" | "source_object_export_failed";
  error?: string;
};

export const formatStorageMissingObjectsDescription = (count: number): string =>
  `${count} source storage object${count === 1 ? " was" : "s were"} skipped because ${count === 1 ? "it was" : "they were"} missing or could not be exported`;

export const sortStorageMissingObjects = (
  objects: StorageMissingObject[],
): StorageMissingObject[] =>
  [...objects].sort((left, right) => {
    const bucketCompare = left.bucketId.localeCompare(right.bucketId);
    return bucketCompare === 0 ? left.objectPath.localeCompare(right.objectPath) : bucketCompare;
  });

const csvColumns = [
  "bucket_id",
  "object_path",
  "project_host",
  "project_role",
  "status_code",
  "reason",
  "error",
] as const;

const escapeCsvValue = (value: string | number | null | undefined): string => {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const buildStorageMissingObjectsCsv = (objects: StorageMissingObject[]): string => {
  const rows = sortStorageMissingObjects(objects).map((object) =>
    [
      object.bucketId,
      object.objectPath,
      object.projectHost,
      object.projectRole,
      object.statusCode,
      object.reason,
      object.error ?? "",
    ]
      .map(escapeCsvValue)
      .join(","),
  );

  return `${csvColumns.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
};
