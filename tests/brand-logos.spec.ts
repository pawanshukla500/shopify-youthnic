import { describe, it, expect } from 'vitest';
import { getCourierLogoUrl, getPaymentLogoUrl } from '../frontend/src/lib';

describe('Brandfetch Logos & Payment Partner Mapping', () => {
  it('maps all supported couriers to their official Brandfetch logos', () => {
    expect(getCourierLogoUrl('Amazon Transportation')).toBe('/logos/amazon.svg');
    expect(getCourierLogoUrl('ATS')).toBe('/logos/amazon.svg');
    expect(getCourierLogoUrl('Velocity')).toBe('/logos/velocity.svg');
    expect(getCourierLogoUrl('Velocity (Amazon Transportation)')).toBe('/logos/amazon.svg');
    expect(getCourierLogoUrl('BlueDart Standard')).toBe('/logos/bluedart.png');
    expect(getCourierLogoUrl('DTDC Express')).toBe('/logos/dtdc.png');
    expect(getCourierLogoUrl('XpressBees Air')).toBe('/logos/xpressbees.png');
    expect(getCourierLogoUrl('Ekart Standard')).toBe('/logos/ekart.png');
    expect(getCourierLogoUrl('Shadowfax Standard')).toBe('/logos/shadowfax.svg');
    expect(getCourierLogoUrl('Ecom Express')).toBe('/logos/ecomexpress.svg');
    expect(getCourierLogoUrl('Delhivery Express')).toBe('/logos/delhivery.svg');
    expect(getCourierLogoUrl(null)).toBe('/logos/delhivery.svg');
  });

  it('maps payment gateways and remittance sources to their official Brandfetch logos', () => {
    // GoKwik
    expect(getPaymentLogoUrl('GoKwik', 'gokwik', 'UPI')).toBe('/logos/gokwik.svg');
    expect(getPaymentLogoUrl(undefined, undefined, undefined, 'GoKwik')).toBe('/logos/gokwik.svg');

    // PhonePe
    expect(getPaymentLogoUrl('PhonePe', 'phonepe_pg', 'UPI')).toBe('/logos/phonepe.svg');
    expect(getPaymentLogoUrl(undefined, undefined, undefined, 'PhonePe')).toBe('/logos/phonepe.svg');

    // Velocity COD Remittance
    expect(getPaymentLogoUrl(undefined, undefined, undefined, 'Velocity')).toBe('/logos/velocity.svg');
    expect(getPaymentLogoUrl('Velocity', undefined, 'COD')).toBe('/logos/velocity.svg');

    // Easebuzz
    expect(getPaymentLogoUrl('Easebuzz', 'easebuzz', 'UPI')).toBe('/logos/easebuzz.svg');

    // Fallback
    expect(getPaymentLogoUrl('Unknown', 'manual', 'cash')).toBe(null);
  });
});
