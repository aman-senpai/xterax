import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { CsvStack as CsvStackType } from "./CsvStack";

const CsvStackInner = lazy(() =>
  import("./CsvStack").then((m) => ({ default: m.CsvStack })),
);

type Props = ComponentProps<typeof CsvStackType>;

export function CsvStack(props: Props) {
  return (
    <Suspense fallback={null}>
      <CsvStackInner {...props} />
    </Suspense>
  );
}
