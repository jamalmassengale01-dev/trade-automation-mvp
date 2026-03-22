'use client';

import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Legend,
} from 'recharts';

interface TradeDataPoint {
  time: string;
  alerts: number;
  trades: number;
  orders: number;
  fillRate?: number;
}

interface TradeChartProps {
  data?: TradeDataPoint[];
  type?: 'line' | 'area' | 'bar';
  showLegend?: boolean;
  height?: number;
}

const defaultData: TradeDataPoint[] = [
  { time: '00:00', alerts: 2, trades: 1, orders: 2, fillRate: 100 },
  { time: '04:00', alerts: 0, trades: 0, orders: 0, fillRate: 0 },
  { time: '08:00', alerts: 5, trades: 3, orders: 6, fillRate: 100 },
  { time: '12:00', alerts: 8, trades: 5, orders: 10, fillRate: 90 },
  { time: '16:00', alerts: 12, trades: 8, orders: 15, fillRate: 95 },
  { time: '20:00', alerts: 6, trades: 4, orders: 8, fillRate: 100 },
  { time: '23:59', alerts: 3, trades: 2, orders: 4, fillRate: 100 },
];

export function TradeVolumeChart({
  data = defaultData,
  type = 'area',
  showLegend = true,
  height = 300,
}: TradeChartProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-[300px] bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />;
  }

  const ChartComponent = type === 'bar' ? BarChart : type === 'line' ? LineChart : AreaChart;
  const DataComponent = type === 'bar' ? Bar : type === 'line' ? Line : Area;

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ChartComponent data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis 
            dataKey="time" 
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
          />
          <YAxis 
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '8px',
              color: 'var(--chart-tooltip-color)',
            }}
          />
          {showLegend && <Legend />}
          
          <DataComponent
            type="monotone"
            dataKey="alerts"
            name="Alerts"
            stroke="#f59e0b"
            fill="#f59e0b"
            fillOpacity={type === 'area' ? 0.3 : 1}
            strokeWidth={2}
          />
          <DataComponent
            type="monotone"
            dataKey="trades"
            name="Trades"
            stroke="#10b981"
            fill="#10b981"
            fillOpacity={type === 'area' ? 0.3 : 1}
            strokeWidth={2}
          />
          <DataComponent
            type="monotone"
            dataKey="orders"
            name="Orders"
            stroke="#3b82f6"
            fill="#3b82f6"
            fillOpacity={type === 'area' ? 0.3 : 1}
            strokeWidth={2}
          />
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}

export function FillRateChart({
  data = defaultData,
  height = 200,
}: { data?: TradeDataPoint[]; height?: number }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-[200px] bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />;
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="fillRateGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis 
            dataKey="time" 
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
          />
          <YAxis 
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
          />
          <Tooltip
            formatter={(value: number) => [`${value}%`, 'Fill Rate']}
            contentStyle={{
              backgroundColor: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '8px',
              color: 'var(--chart-tooltip-color)',
            }}
          />
          <Area
            type="monotone"
            dataKey="fillRate"
            name="Fill Rate"
            stroke="#10b981"
            fill="url(#fillRateGradient)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AccountPerformanceChart({
  data,
  height = 250,
}: {
  data?: Array<{ name: string; profit: number; trades: number }>;
  height?: number;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const defaultPerfData = [
    { name: 'Account 1', profit: 1250, trades: 15 },
    { name: 'Account 2', profit: -450, trades: 8 },
    { name: 'Account 3', profit: 890, trades: 12 },
    { name: 'Account 4', profit: 0, trades: 5 },
  ];

  const chartData = data || defaultPerfData;

  if (!mounted) {
    return <div className="h-[250px] bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" />;
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
          <XAxis 
            type="number" 
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            tickFormatter={(value) => `$${value}`}
          />
          <YAxis 
            type="category" 
            dataKey="name"
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            width={100}
          />
          <Tooltip
            formatter={(value: number, name: string) => {
              if (name === 'profit') return [`$${value}`, 'P&L'];
              return [value, name];
            }}
            contentStyle={{
              backgroundColor: 'var(--chart-tooltip-bg)',
              border: '1px solid var(--chart-tooltip-border)',
              borderRadius: '8px',
              color: 'var(--chart-tooltip-color)',
            }}
          />
          <Legend />
          <Bar
            dataKey="profit"
            name="P&L"
            fill="#3b82f6"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
