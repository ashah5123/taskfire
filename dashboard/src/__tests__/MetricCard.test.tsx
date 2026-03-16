import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MetricCard } from '../components/MetricCard'

describe('MetricCard', () => {
  it('renders the label', () => {
    render(<MetricCard label="Queue Depth" value={42} />)
    expect(screen.getByText('Queue Depth')).toBeInTheDocument()
  })

  it('renders the numeric value', () => {
    render(<MetricCard label="Jobs" value={99} />)
    expect(screen.getByText('99')).toBeInTheDocument()
  })

  it('renders unit when provided', () => {
    render(<MetricCard label="Latency" value={123} unit="ms" />)
    expect(screen.getByText('ms')).toBeInTheDocument()
  })

  it('renders subtitle when provided', () => {
    render(<MetricCard label="Workers" value={4} subtitle="active goroutines" />)
    expect(screen.getByText('active goroutines')).toBeInTheDocument()
  })

  it('applies custom formatter', () => {
    const formatter = (v: number) => `${(v / 1000).toFixed(1)}k`
    render(<MetricCard label="Processed" value={5000} formatter={formatter} />)
    expect(screen.getByText('5.0k')).toBeInTheDocument()
  })

  it('shows upward trend indicator when value increased and higherIsBetter', () => {
    render(
      <MetricCard label="Throughput" value={100} previousValue={80} higherIsBetter />
    )
    expect(screen.getByText(/▲/)).toBeInTheDocument()
  })

  it('shows downward trend indicator when value decreased and higherIsBetter', () => {
    render(
      <MetricCard label="Throughput" value={60} previousValue={80} higherIsBetter />
    )
    expect(screen.getByText(/▼/)).toBeInTheDocument()
  })

  it('shows neutral trend when value is unchanged', () => {
    render(
      <MetricCard label="Errors" value={5} previousValue={5} higherIsBetter={false} />
    )
    expect(screen.getByText(/→/)).toBeInTheDocument()
  })

  it('shows downward trend as good when higherIsBetter is false', () => {
    render(
      <MetricCard label="Failures" value={2} previousValue={10} higherIsBetter={false} />
    )
    // When higherIsBetter=false, a decrease is good → downward arrow shown
    expect(screen.getByText(/▼/)).toBeInTheDocument()
  })

  it('renders without previousValue without error', () => {
    render(<MetricCard label="Pending" value={7} />)
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.queryByText(/▲/)).not.toBeInTheDocument()
    expect(screen.queryByText(/▼/)).not.toBeInTheDocument()
  })
})
