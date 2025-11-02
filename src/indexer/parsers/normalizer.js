import crypto from 'crypto';

const buildSymbolId = ({ filePath, name, kind, location }) => {
  const hash = crypto
    .createHash('sha1')
    .update(`${filePath}|${name}|${kind}|${location?.start?.line ?? 0}|${location?.start?.column ?? 0}`)
    .digest('hex')
    .slice(0, 12);
  return `${filePath}#${name}:${location?.start?.line ?? 0}:${hash}`;
};

export const createSymbolEntity = ({
  filePath,
  language,
  name,
  kind,
  signature,
  location,
  detail = {},
  properties = {},
}) => {
  const safeLocation =
    location ??
    {
      start: { line: 0, column: 0 },
      end: { line: 0, column: 0 },
    };
  return {
    id: buildSymbolId({ filePath, name, kind, location: safeLocation }),
    filePath,
    language,
    name,
    kind,
    signature,
    location: safeLocation,
    detail,
    properties,
  };
};

export const createRelationEntity = ({
  type,
  sourceId,
  targetId,
  properties = {},
}) => ({
  type,
  sourceId,
  targetId,
  properties,
});

export const createDiagnostic = ({
  message,
  severity = 'warning',
  location,
}) => ({
  message,
  severity,
  location,
});

export const serializeRelationsForSymbol = (symbolId, relations = []) =>
  relations.filter((relation) => relation.sourceId === symbolId || relation.targetId === symbolId);
