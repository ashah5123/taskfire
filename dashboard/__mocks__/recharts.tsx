import React from 'react'

// Minimal stubs for every recharts component used in production code.
// SVG is not available in jsdom, so we replace chart primitives with
// plain <div>s that preserve testid attributes for assertions.

const stub =
  (testid: string) =>
  ({ children }: { children?: React.ReactNode }) =>
    <div data-testid={testid}>{children}</div>

const noopStub = () => <div />

export const ResponsiveContainer = stub('recharts-responsive-container')
export const AreaChart           = stub('recharts-area-chart')
export const BarChart            = stub('recharts-bar-chart')
export const LineChart           = stub('recharts-line-chart')
export const ComposedChart       = stub('recharts-composed-chart')

export const Area          = noopStub
export const Bar           = noopStub
export const Line          = noopStub
export const Cell          = noopStub
export const XAxis         = noopStub
export const YAxis         = noopStub
export const CartesianGrid = noopStub
export const Tooltip       = noopStub
export const Legend        = noopStub
export const ReferenceLine = noopStub
