interface LogFields {
  requestId?: string;
  accountId?: string;
  [key: string]: unknown;
}

function emit(level: "info" | "warn" | "error", message: string, fields?: LogFields) {
  const line = {
    level,
    message,
    time: new Date().toISOString(),
    ...fields,
  };
  const serialized = JSON.stringify(line, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value
  );
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
