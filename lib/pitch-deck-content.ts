// Static, non-opportunity-specific slide content for the client pitch deck.
// Amazon Shipping Spain's service capabilities and standard onboarding
// process don't vary per client, so these are hardcoded rather than
// generated per opportunity. Capability figures transcribed from
// Service_description.pptx (IE University / Industry Challenge 2026 deck).

export const CAPABILITIES_SLIDE_BULLETS: string[] = [
  "Every shipment, every channel: pickup at your warehouse, injection in our Sort Centers, express delivery in 1-2 days across mainland Spain",
  "24-48 hour delivery with exceptional peak season performance, including 7/7 injection and delivery — Saturday and Sunday included",
  "High reliability: 98.7% delivery accuracy, up to 5 delivery attempts, 60-second callback by phone",
  "Tracking in 100% of shipments, simplified all-included pricing (no fuel surcharge), easy claim management",
  "Premium delivery features: One-Time Password (OTP), Signature on Delivery (SOD), Photo on Unattended Delivery (POUD)",
  "Shipper Central Interface: manage shipments via API integration or an easy-to-use web interface — same experience for all Amazon Shipping features",
];

export const IMPLEMENTATION_PLAN_BULLETS: string[] = [
  "Weeks 1-2 — Onboarding: confirm scope, volumes, and SLA; provision Shipper Central access",
  "Weeks 3-4 — Integration: connect via API or web interface; validate label generation and tracking",
  "Weeks 5-6 — Pilot: run a limited-volume pilot across target routes; validate peak/weekend delivery flows",
  "Week 7 onward — Go-live: scale to full volume with dedicated account support",
];
