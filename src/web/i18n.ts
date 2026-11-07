export type Language = 'en' | 'it';
export const translations = {
  en: { swap: 'DeFi Swap', bank: 'Bank', settings: 'Settings', connect: 'Connect wallet', tagline: 'Your favorite port to enter and exit the fiat realm. No KYC required.', readOnly: 'Read-only mode', pay: 'You pay', receive: 'You receive', quote: 'Find a route', disconnected: 'Wallet not connected', route: 'Route details', network: 'Network', language: 'Language', safety: 'Your keys stay in your wallet' },
  it: { swap: 'DeFi Swap', bank: 'Banca', settings: 'Impostazioni', connect: 'Collega wallet', tagline: 'Your favorite port to enter and exit the fiat realm. No KYC required.', readOnly: 'Modalità sola lettura', pay: 'Paghi', receive: 'Ricevi', quote: 'Trova una rotta', disconnected: 'Wallet non collegato', route: 'Dettagli della rotta', network: 'Rete', language: 'Lingua', safety: 'Le chiavi restano nel tuo wallet' },
} as const;
export function initialLanguage(hostLanguage?: string): Language { return hostLanguage?.split('-')[0] === 'it' ? 'it' : 'en'; }
