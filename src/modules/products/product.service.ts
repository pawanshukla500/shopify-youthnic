import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import logger from '../../utils/logger';
import { shopifyTokenProvider } from '../shopify/token.provider';
import {
  ShopifyProduct,
  ShopifyProductVariant,
  ShopifyProductImage,
  ProductSummary,
} from '../../types';

export interface CreateProductInput {
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  status?: 'active' | 'draft' | 'archived';
  tags?: string;
  images?: Array<{ src: string; alt?: string; position?: number }>;
  options?: Array<{ name: string; values: string[] }>;
  variants?: Array<{
    title?: string;
    price: string | number;
    compare_at_price?: string | number | null;
    sku?: string;
    barcode?: string;
    inventory_quantity?: number;
    option1?: string;
    option2?: string;
    option3?: string;
    weight?: number;
    weight_unit?: string;
    requires_shipping?: boolean;
    inventory_management?: string;
  }>;
}

export interface UpdateProductInput {
  title?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  status?: 'active' | 'draft' | 'archived';
  tags?: string;
  images?: Array<{ id?: number; src: string; alt?: string; position?: number }>;
  variants?: Array<{
    id?: number;
    title?: string;
    price?: string | number;
    compare_at_price?: string | number | null;
    sku?: string;
    barcode?: string;
    inventory_quantity?: number;
    option1?: string;
    option2?: string;
    option3?: string;
    weight?: number;
    weight_unit?: string;
  }>;
}

export interface ListProductsQuery {
  limit?: number;
  status?: 'active' | 'draft' | 'archived' | 'all';
  title?: string;
  product_type?: string;
  vendor?: string;
  page_info?: string;
  since_id?: number;
}

class ProductService {
  private client: AxiosInstance;
  private defaultLocationId: number | null = 70444449991;

  constructor() {
    const baseUrl = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.client.interceptors.request.use(async (requestConfig) => {
      requestConfig.headers['X-Shopify-Access-Token'] =
        await shopifyTokenProvider.getAccessToken();
      return requestConfig;
    });
  }

  /**
   * Get primary Shopify store location ID for inventory management.
   */
  async getDefaultLocationId(): Promise<number> {
    if (this.defaultLocationId) return this.defaultLocationId;
    try {
      const res = await this.client.get('/locations.json');
      const locations = res.data?.locations || [];
      const primary = locations.find((l: any) => l.active) || locations[0];
      if (primary?.id) {
        this.defaultLocationId = primary.id;
        return primary.id;
      }
    } catch (err: any) {
      logger.warn('Failed to fetch Shopify locations', { error: err.message });
    }
    return 70444449991;
  }

  /**
   * List all products with optional filters (status, title search, type, vendor).
   */
  async listProducts(query: ListProductsQuery = {}): Promise<{
    products: ShopifyProduct[];
    total: number;
    nextPageUrl?: string | null;
  }> {
    try {
      const limit = query.limit || 50;
      let rawProducts: ShopifyProduct[] = [];

      if (query.status && ['active', 'draft', 'archived'].includes(query.status)) {
        const params: Record<string, any> = {
          limit,
          status: query.status,
        };
        if (query.title) params.title = query.title;
        if (query.product_type) params.product_type = query.product_type;
        if (query.vendor) params.vendor = query.vendor;
        if (query.page_info) params.page_info = query.page_info;
        if (query.since_id) params.since_id = query.since_id;

        const res = await this.client.get('/products.json', { params });
        rawProducts = res.data?.products || [];
      } else {
        // 'all' or undefined: fetch active and drafts in parallel
        const activeParams: Record<string, any> = { limit: Math.ceil(limit / 2), status: 'active' };
        const draftParams: Record<string, any> = { limit: Math.ceil(limit / 2), status: 'draft' };
        if (query.title) {
          activeParams.title = query.title;
          draftParams.title = query.title;
        }
        if (query.product_type) {
          activeParams.product_type = query.product_type;
          draftParams.product_type = query.product_type;
        }
        if (query.vendor) {
          activeParams.vendor = query.vendor;
          draftParams.vendor = query.vendor;
        }

        const [activeRes, draftRes] = await Promise.all([
          this.client.get('/products.json', { params: activeParams }),
          this.client.get('/products.json', { params: draftParams }),
        ]);

        const activeList = activeRes.data?.products || [];
        const draftList = draftRes.data?.products || [];
        rawProducts = [...activeList, ...draftList].sort(
          (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
      }

      // Calculate total inventory per product
      const products: ShopifyProduct[] = rawProducts.map((prod) => {
        const totalStock = (prod.variants || []).reduce(
          (sum, v) => sum + (Number(v.inventory_quantity) || 0),
          0
        );
        return {
          ...prod,
          total_inventory: totalStock,
        };
      });

      return {
        products,
        total: products.length,
      };
    } catch (error: any) {
      logger.error('Failed to list products from Shopify', {
        error: error.response?.data || error.message,
      });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Compute comprehensive catalog KPI metrics via count APIs.
   */
  async getProductSummary(): Promise<ProductSummary> {
    try {
      const [activeCountRes, draftCountRes, archivedCountRes, sampleProductsRes] = await Promise.all([
        this.client.get('/products/count.json?status=active'),
        this.client.get('/products/count.json?status=draft'),
        this.client.get('/products/count.json?status=archived'),
        this.client.get('/products.json?limit=250&status=active'),
      ]);

      const active = activeCountRes.data?.count || 0;
      const draft = draftCountRes.data?.count || 0;
      const archived = archivedCountRes.data?.count || 0;
      const total = active + draft + archived;

      const sampleProducts: ShopifyProduct[] = sampleProductsRes.data?.products || [];
      let outOfStock = 0;
      let lowStock = 0;
      let totalInventory = 0;

      for (const prod of sampleProducts) {
        const prodStock = (prod.variants || []).reduce(
          (sum, v) => sum + (Number(v.inventory_quantity) || 0),
          0
        );
        totalInventory += prodStock;

        if (prodStock === 0) {
          outOfStock++;
        } else if (prodStock <= 5) {
          lowStock++;
        }
      }

      return {
        total,
        active,
        draft,
        archived,
        outOfStock,
        lowStock,
        totalInventory,
      };
    } catch (error: any) {
      logger.error('Failed to get product summary', { error: error.message });
      return {
        total: 0,
        active: 0,
        draft: 0,
        archived: 0,
        outOfStock: 0,
        lowStock: 0,
        totalInventory: 0,
      };
    }
  }

  /**
   * Get single product with full details, variant stock, and image gallery.
   */
  async getProduct(id: number | string): Promise<ShopifyProduct> {
    try {
      const response = await this.client.get(`/products/${id}.json`);
      const product: ShopifyProduct = response.data?.product;
      if (!product) throw new Error('Product not found');

      product.total_inventory = (product.variants || []).reduce(
        (sum, v) => sum + (Number(v.inventory_quantity) || 0),
        0
      );

      return product;
    } catch (error: any) {
      logger.error('Failed to get product by id', { id, error: error.message });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Create a new product listing on Shopify.
   */
  async createProduct(input: CreateProductInput): Promise<ShopifyProduct> {
    try {
      const locationId = await this.getDefaultLocationId();

      const productPayload: Record<string, any> = {
        title: input.title.trim(),
        body_html: input.body_html || '',
        vendor: input.vendor?.trim() || 'Youthnic',
        product_type: input.product_type?.trim() || 'Ethnic Wear',
        status: input.status || 'active',
        tags: input.tags || '',
      };

      if (input.images && input.images.length > 0) {
        productPayload.images = input.images.map((img, idx) => ({
          src: img.src,
          alt: img.alt || input.title,
          position: img.position || idx + 1,
        }));
      }

      if (input.options && input.options.length > 0) {
        productPayload.options = input.options.map((opt, idx) => ({
          name: opt.name,
          position: idx + 1,
          values: opt.values,
        }));
      }

      if (input.variants && input.variants.length > 0) {
        productPayload.variants = input.variants.map((v) => ({
          title: v.title || 'Default Title',
          price: String(v.price),
          compare_at_price: v.compare_at_price ? String(v.compare_at_price) : null,
          sku: v.sku || '',
          barcode: v.barcode || '',
          option1: v.option1 || null,
          option2: v.option2 || null,
          option3: v.option3 || null,
          weight: v.weight || 0.5,
          weight_unit: v.weight_unit || 'kg',
          requires_shipping: v.requires_shipping !== false,
          inventory_management: 'shopify',
        }));
      }

      const response = await this.client.post('/products.json', {
        product: productPayload,
      });

      const createdProduct: ShopifyProduct = response.data?.product;

      if (input.variants && createdProduct.variants) {
        for (let i = 0; i < input.variants.length; i++) {
          const reqVar = input.variants[i];
          const createdVar = createdProduct.variants[i];
          if (
            reqVar &&
            createdVar &&
            reqVar.inventory_quantity !== undefined &&
            createdVar.inventory_item_id
          ) {
            try {
              await this.setVariantInventory(
                createdVar.inventory_item_id,
                Number(reqVar.inventory_quantity),
                locationId
              );
            } catch (invErr: any) {
              logger.warn('Failed to set initial inventory on variant', {
                variantId: createdVar.id,
                error: invErr.message,
              });
            }
          }
        }
      }

      logger.info('Shopify product created successfully', {
        productId: createdProduct.id,
        title: createdProduct.title,
      });

      return await this.getProduct(createdProduct.id);
    } catch (error: any) {
      logger.error('Failed to create Shopify product', {
        error: error.response?.data || error.message,
      });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Update an existing product listing.
   */
  async updateProduct(
    id: number | string,
    input: UpdateProductInput
  ): Promise<ShopifyProduct> {
    try {
      const payload: Record<string, any> = { id: Number(id) };

      if (input.title !== undefined) payload.title = input.title.trim();
      if (input.body_html !== undefined) payload.body_html = input.body_html;
      if (input.vendor !== undefined) payload.vendor = input.vendor.trim();
      if (input.product_type !== undefined) payload.product_type = input.product_type.trim();
      if (input.status !== undefined) payload.status = input.status;
      if (input.tags !== undefined) payload.tags = input.tags;

      if (input.images !== undefined) {
        payload.images = input.images;
      }

      if (input.variants && input.variants.length > 0) {
        payload.variants = input.variants.map((v) => ({
          ...(v.id ? { id: v.id } : {}),
          ...(v.title ? { title: v.title } : {}),
          ...(v.price !== undefined ? { price: String(v.price) } : {}),
          ...(v.compare_at_price !== undefined
            ? { compare_at_price: v.compare_at_price ? String(v.compare_at_price) : null }
            : {}),
          ...(v.sku !== undefined ? { sku: v.sku } : {}),
          ...(v.barcode !== undefined ? { barcode: v.barcode } : {}),
          ...(v.option1 !== undefined ? { option1: v.option1 } : {}),
          ...(v.option2 !== undefined ? { option2: v.option2 } : {}),
          ...(v.option3 !== undefined ? { option3: v.option3 } : {}),
          inventory_management: 'shopify',
        }));
      }

      const response = await this.client.put(`/products/${id}.json`, {
        product: payload,
      });

      const updatedProduct: ShopifyProduct = response.data?.product;

      if (input.variants) {
        const locationId = await this.getDefaultLocationId();
        for (const v of input.variants) {
          if (v.id && v.inventory_quantity !== undefined) {
            const currentVar = updatedProduct.variants?.find((uv) => uv.id === v.id);
            if (currentVar?.inventory_item_id) {
              try {
                await this.setVariantInventory(
                  currentVar.inventory_item_id,
                  Number(v.inventory_quantity),
                  locationId
                );
              } catch (invErr: any) {
                logger.warn('Failed to update variant inventory', {
                  variantId: v.id,
                  error: invErr.message,
                });
              }
            }
          }
        }
      }

      logger.info('Shopify product updated successfully', { id });
      return await this.getProduct(id);
    } catch (error: any) {
      logger.error('Failed to update Shopify product', {
        id,
        error: error.response?.data || error.message,
      });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Delete product listing from Shopify store.
   */
  async deleteProduct(id: number | string): Promise<{ success: boolean; message: string }> {
    try {
      await this.client.delete(`/products/${id}.json`);
      logger.info('Shopify product deleted successfully', { id });
      return { success: true, message: `Product #${id} deleted permanently from Shopify store.` };
    } catch (error: any) {
      logger.error('Failed to delete Shopify product', { id, error: error.message });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Quick status switch (active, draft, archived).
   */
  async setProductStatus(
    id: number | string,
    status: 'active' | 'draft' | 'archived'
  ): Promise<ShopifyProduct> {
    try {
      const response = await this.client.put(`/products/${id}.json`, {
        product: { id: Number(id), status },
      });
      logger.info('Product status changed', { id, status });
      return response.data?.product;
    } catch (error: any) {
      logger.error('Failed to toggle product status', { id, status, error: error.message });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Set inventory quantity for a variant's inventory_item_id at location.
   */
  async setVariantInventory(
    inventoryItemId: number,
    available: number,
    locationId?: number
  ): Promise<{ success: boolean; available: number }> {
    try {
      const locId = locationId || (await this.getDefaultLocationId());
      const response = await this.client.post('/inventory_levels/set.json', {
        location_id: locId,
        inventory_item_id: inventoryItemId,
        available: Math.max(0, Math.round(available)),
      });

      return {
        success: true,
        available: response.data?.inventory_level?.available ?? available,
      };
    } catch (error: any) {
      logger.error('Failed to set inventory level on Shopify', {
        inventoryItemId,
        error: error.response?.data || error.message,
      });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Add image URL to a product.
   */
  async addProductImage(
    productId: number | string,
    imageUrl: string,
    alt?: string
  ): Promise<ShopifyProductImage> {
    try {
      const response = await this.client.post(`/products/${productId}/images.json`, {
        image: {
          src: imageUrl,
          alt: alt || '',
        },
      });
      return response.data?.image;
    } catch (error: any) {
      logger.error('Failed to add product image', { productId, error: error.message });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }

  /**
   * Delete an image from a product.
   */
  async deleteProductImage(
    productId: number | string,
    imageId: number | string
  ): Promise<{ success: boolean }> {
    try {
      await this.client.delete(`/products/${productId}/images/${imageId}.json`);
      return { success: true };
    } catch (error: any) {
      logger.error('Failed to delete product image', { productId, imageId, error: error.message });
      throw new Error(
        error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message
      );
    }
  }
}

export const productService = new ProductService();
export default productService;
