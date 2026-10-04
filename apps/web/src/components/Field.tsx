import { cloneElement, useId, type ReactElement } from 'react';

/** Associate only the visible caption with a control, excluding select options. */
export default function Field({ label, children, wide = false }: {
  label: string;
  children: ReactElement<{ id?: string }>;
  wide?: boolean;
}) {
  const id = useId();
  return <div className={`field ${wide ? 'field-wide' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {cloneElement(children, { id })}
  </div>;
}
