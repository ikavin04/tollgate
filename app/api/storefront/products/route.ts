import { NextRequest, NextResponse, connection } from 'next/server';
import { getDb } from '@/lib/db';
import { jsonErrorResponse } from '@/lib/http';
import {
  listAllCatalogProducts,
  renderStorefrontPageText,
  searchCatalogProducts,
} from '@/lib/storefront';

export async function GET(request: NextRequest) {
  await connection();
  try {
    const db = getDb();
    const params = request.nextUrl.searchParams;
    const includePageText = params.get('includePageText') === 'true';

    const query = params.get('query') ?? undefined;
    const category = params.get('category') ?? undefined;
    const brand = params.get('brand') ?? undefined;
    const condition = params.get('condition') ?? undefined;
    const maxPriceStr = params.get('maxPriceUsd');
    const maxPriceUsd = maxPriceStr ? Number(maxPriceStr) : undefined;

    const products = searchCatalogProducts(db, {
      query,
      category,
      brand,
      condition,
      maxPriceUsd: Number.isFinite(maxPriceUsd) ? maxPriceUsd : undefined,
      limit: 50,
    });

    if (!includePageText) {
      return NextResponse.json({ products });
    }

    const rawCatalog = new Map(listAllCatalogProducts(db).map((p) => [p.id, p]));
    return NextResponse.json({
      products: products.map((p) => {
        const raw = rawCatalog.get(p.id);
        return {
          ...p,
          safe_extracted_page_text: raw ? renderStorefrontPageText(raw) : '',
        };
      }),
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}
