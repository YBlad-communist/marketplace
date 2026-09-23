import type { Config } from 'tailwindcss';

// DECISION: сохраняем имя палитры `brand`, но перекрашиваем её в зелёную шкалу
// accent — чтобы сотни существующих классов bg-brand-600/text-brand-700
// автоматически перешли на новую систему без правок логики и разметки.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#DCFCE7',
          100: '#DCFCE7',
          500: '#22C55E',
          600: '#16A34A',
          700: '#15803D',
        },
        background: '#FAFAFA',
        surface: '#FFFFFF',
        surfaceMuted: '#F3F4F6',
        border: '#E5E7EB',
        textPrimary: '#111827',
        textSecondary: '#6B7280',
        textMuted: '#9CA3AF',
        accent: '#16A34A',
        accentHover: '#15803D',
        accentActive: '#166534',
        accentSoft: '#DCFCE7',
        danger: '#DC2626',
        warning: '#F59E0B',
        success: '#16A34A',
        info: '#0EA5E9',
      },
      ringColor: {
        focus: 'rgba(34, 197, 94, 0.4)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17, 24, 39, 0.06)',
        'card-hover': '0 4px 12px rgba(17, 24, 39, 0.1)',
        modal: '0 12px 32px rgba(17, 24, 39, 0.18)',
      },
      maxWidth: {
        container: '1280px',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      lineHeight: {
        heading: '1.4',
        body: '1.6',
      },
    },
  },
  plugins: [],
};

export default config;
