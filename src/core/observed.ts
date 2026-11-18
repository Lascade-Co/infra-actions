// Observed state shared by every module: the DigitalOcean droplets as they are now.
//
// The droplets module (src/droplets) reads them; the engine joins them with the droplet
// files (core/desired.ts) before any other module plans. Each module keeps the rest of
// its observed state (Cloudflare apps, firewalls, monitors...) in its own types.

export interface ObservedDroplet {
  id: number;
  name: string;
  /** Region slug, e.g. nyc1. */
  region: string;
  /** networks.v4[type=private]; undefined while a new droplet has none yet. */
  privateIpv4?: string;
  publicIpv4?: string;
  publicIpv6?: string;
  /** Every tag on the droplet, including ones the tool doesn't manage. */
  tags: string[];
  vpcUuid?: string;
  /** DigitalOcean status: new | active | off | archive. */
  status: string;
  sizeSlug?: string;
  imageSlug?: string;
  createdAt?: string;
}

export interface DropletsObserved {
  droplets: ObservedDroplet[];
}
