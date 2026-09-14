export function validateDatabaseOwnership({ ownership, modeledTables, sourceFileValid }) {
  const prismaOwnedMissingModel = (ownership.prisma_owned ?? []).filter(
    (table) => !modeledTables.has(table),
  );

  const rawSqlMissingSource = (ownership.raw_sql_owned ?? []).filter((table) => {
    const info = ownership.tables?.[table];
    const sources = [
      ...(Array.isArray(info?.source_files) ? info.source_files : []),
      ...(typeof info?.schema_owner_sql === "string" ? [info.schema_owner_sql] : []),
    ].filter(Boolean);
    return sources.length === 0 || !sources.some((source) => sourceFileValid(source, table));
  });

  const productionCriticalUnknown = (ownership.unknown ?? []).filter((table) => {
    const info = ownership.tables?.[table];
    return Boolean(info && (info.read_by_runtime || info.written_by_runtime));
  });

  return { prismaOwnedMissingModel, rawSqlMissingSource, productionCriticalUnknown };
}
