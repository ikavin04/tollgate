import 'server-only';
import type Database from 'better-sqlite3';
import { formatCents } from '@/lib/crypto';
import { extractSafePageText } from '@/lib/evidence';
import type { CatalogProduct } from '@/lib/policy/engine';

export interface StorefrontSearchQuery {
  query?: string;
  category?: string;
  brand?: string;
  maxPriceUsd?: number;
  condition?: string;
  limit?: number;
}

/**
 * Realistic storefront product DTO exposed to the shopping agent and public catalog search.
 * Intentionally excludes internal evaluation flags (is_malicious_scenario, scenario_tag).
 */
export interface StorefrontProductDTO {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  price_cents: number;
  price_usd: string;
  currency: string;
  condition: string;
  ram_gb: number | null;
  storage_gb: number | null;
  weight_kg: number | null;
  warranty_summary: string;
  extended_warranty_included: boolean;
  specifications: Record<string, unknown>;
  storefront_path: string;
  in_stock: boolean;
}

export function toStorefrontDTO(row: CatalogProduct): StorefrontProductDTO {
  let specs: Record<string, unknown> = {};
  try {
    specs = JSON.parse(row.specifications_json) as Record<string, unknown>;
  } catch {
    specs = {};
  }
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    brand: row.brand,
    category: row.category,
    price_cents: row.price_cents,
    price_usd: formatCents(row.price_cents),
    currency: row.currency,
    condition: row.condition,
    ram_gb: row.ram_gb,
    storage_gb: row.storage_gb,
    weight_kg: row.weight_kg,
    warranty_summary: row.warranty_summary,
    extended_warranty_included: row.extended_warranty_included === 1,
    specifications: specs,
    storefront_path: row.storefront_path,
    in_stock: row.in_stock === 1,
  };
}

export function listAllCatalogProducts(db: Database.Database): CatalogProduct[] {
  return db
    .prepare('SELECT * FROM products ORDER BY category ASC, price_cents ASC')
    .all() as CatalogProduct[];
}

export function getCatalogProductById(
  db: Database.Database,
  productId: string
): CatalogProduct | null {
  const row = db
    .prepare('SELECT * FROM products WHERE id = ?')
    .get(productId) as CatalogProduct | undefined;
  return row ?? null;
}

function filterCatalogProducts(
  db: Database.Database,
  params: StorefrontSearchQuery
): CatalogProduct[] {
  const all = listAllCatalogProducts(db).filter((p) => p.in_stock === 1);
  const query = params.query?.trim().toLowerCase();
  const category = params.category?.trim().toLowerCase();
  const brand = params.brand?.trim().toLowerCase();
  const condition = params.condition?.trim().toLowerCase();
  const maxCents =
    typeof params.maxPriceUsd === 'number' && Number.isFinite(params.maxPriceUsd)
      ? Math.round(params.maxPriceUsd * 100)
      : null;

  const filtered = all.filter((p) => {
    if (category && p.category.toLowerCase() !== category) return false;
    if (brand && p.brand.toLowerCase() !== brand) return false;
    if (condition && p.condition.toLowerCase() !== condition) return false;
    if (maxCents !== null && p.price_cents > maxCents) return false;
    if (query) {
      const hay = `${p.id} ${p.sku} ${p.name} ${p.brand} ${p.category} ${p.warranty_summary} ${p.specifications_json}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  return filtered.slice(0, limit);
}

export function searchCatalogProducts(
  db: Database.Database,
  params: StorefrontSearchQuery
): StorefrontProductDTO[] {
  return filterCatalogProducts(db, params).map(toStorefrontDTO);
}

export function renderStorefrontPageText(product: CatalogProduct): string {
  return extractSafePageText(product.raw_html_template);
}
