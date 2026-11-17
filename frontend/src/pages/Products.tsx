import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProducts,
  getProductSummary,
  createProduct,
  updateProduct,
  deleteProduct,
  setProductStatus,
  setVariantInventory,
  apiError,
} from '../api'
import {
  Button,
  EmptyState,
  ErrorBox,
  FormField,
  Icon,
  LoadingState,
  PageIntro,
  Panel,
  useDocumentTitle,
  useToast,
} from '../components/UI'
import type {
  ShopifyProduct,
  CreateProductInput,
  UpdateProductInput,
} from '../types'

type ProductTab = 'all' | 'active' | 'draft' | 'archived' | 'low_stock'

export function Products() {
  useDocumentTitle('Products & Listings')
  const toast = useToast()
  const queryClient = useQueryClient()

  // Filters & State
  const [activeTab, setActiveTab] = useState<ProductTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedType, setSelectedType] = useState('ALL')
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'title' | 'stock_high' | 'stock_low'>('newest')

  // Modals
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<ShopifyProduct | null>(null)
  const [stockAdjustProduct, setStockAdjustProduct] = useState<ShopifyProduct | null>(null)
  const [deletingProduct, setDeletingProduct] = useState<ShopifyProduct | null>(null)

  // Quick Stock adjustment state: variantId -> available
  const [variantStockInputs, setVariantStockInputs] = useState<Record<number, number>>({})

  // Queries
  const summaryQuery = useQuery({
    queryKey: ['products-summary'],
    queryFn: getProductSummary,
    staleTime: 30_000,
  })

  const statusParam = activeTab === 'all' || activeTab === 'low_stock' ? 'all' : activeTab
  const productsQuery = useQuery({
    queryKey: ['products', statusParam, searchQuery, selectedType, sortBy],
    queryFn: () => getProducts({ status: statusParam, limit: 100 }),
    staleTime: 30_000,
  })

  // Mutations
  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Product created on Shopify!')
      setIsAddModalOpen(false)
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateProductInput }) => updateProduct(id, data),
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Product updated on Shopify!')
      setEditingProduct(null)
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Product deleted from Shopify.')
      setDeletingProduct(null)
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'active' | 'draft' | 'archived' }) =>
      setProductStatus(id, status),
    onSuccess: (data) => {
      toast.toast('success', data.message || 'Status updated on Shopify!')
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const stockMutation = useMutation({
    mutationFn: setVariantInventory,
    onSuccess: () => {
      toast.toast('success', 'Stock updated on Shopify warehouse inventory!')
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
    onError: (err) => toast.toast('error', apiError(err)),
  })

  const summary = summaryQuery.data?.summary || {
    total: 0,
    active: 0,
    draft: 0,
    archived: 0,
    outOfStock: 0,
    lowStock: 0,
    totalInventory: 0,
  }

  const rawProducts = productsQuery.data?.products || []

  // Extract unique product types
  const productTypes = useMemo(() => {
    const set = new Set<string>()
    rawProducts.forEach((p) => {
      if (p.product_type) set.add(p.product_type)
    })
    return ['ALL', ...Array.from(set)]
  }, [rawProducts])

  // Filter and sort products
  const filteredProducts = useMemo(() => {
    let list = [...rawProducts]

    // Tab filter for low stock
    if (activeTab === 'low_stock') {
      list = list.filter((p) => (p.total_inventory ?? 0) <= 5)
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.vendor && p.vendor.toLowerCase().includes(q)) ||
          (p.tags && p.tags.toLowerCase().includes(q)) ||
          p.variants?.some((v) => v.sku?.toLowerCase().includes(q))
      )
    }

    // Type filter
    if (selectedType !== 'ALL') {
      list = list.filter((p) => p.product_type === selectedType)
    }

    // Sort
    list.sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      }
      if (sortBy === 'oldest') {
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
      }
      if (sortBy === 'title') {
        return a.title.localeCompare(b.title)
      }
      if (sortBy === 'stock_high') {
        return (b.total_inventory ?? 0) - (a.total_inventory ?? 0)
      }
      if (sortBy === 'stock_low') {
        return (a.total_inventory ?? 0) - (b.total_inventory ?? 0)
      }
      return 0
    })

    return list
  }, [rawProducts, activeTab, searchQuery, selectedType, sortBy])

  // Open Quick Stock modal
  const handleOpenStockAdjust = (prod: ShopifyProduct) => {
    const initial: Record<number, number> = {}
    prod.variants?.forEach((v) => {
      if (v.id) initial[v.id] = v.inventory_quantity ?? 0
    })
    setVariantStockInputs(initial)
    setStockAdjustProduct(prod)
  }

  // Save quick stock
  const handleSaveStockAdjust = async () => {
    if (!stockAdjustProduct) return
    let updatedCount = 0
    for (const v of stockAdjustProduct.variants || []) {
      if (v.id && v.inventory_item_id && variantStockInputs[v.id] !== undefined) {
        const newVal = variantStockInputs[v.id]
        if (newVal !== v.inventory_quantity) {
          try {
            await stockMutation.mutateAsync({
              inventoryItemId: v.inventory_item_id,
              available: newVal,
            })
            updatedCount++
          } catch (e) {
            // Error handled by mutation
          }
        }
      }
    }
    if (updatedCount > 0) {
      toast.toast('success', `Updated stock for ${updatedCount} variant(s)!`)
    }
    setStockAdjustProduct(null)
  }

  return (
    <div className="page-content">
      <PageIntro
        eyebrow="Shopify Catalog & Inventory"
        title="Products & Listings"
        action={
          <div style={{ display: 'flex', gap: '10px' }}>
            <Button
              className="button-secondary"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ['products'] })
                queryClient.invalidateQueries({ queryKey: ['products-summary'] })
                toast.toast('success', 'Catalog synchronized with Shopify')
              }}
              title="Refresh catalog from Shopify store"
            >
              <Icon name="refresh" size={15} />
              <span>Sync Shopify</span>
            </Button>
            <Button
              className="button-primary"
              style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
              onClick={() => setIsAddModalOpen(true)}
            >
              <Icon name="plus" size={15} />
              <span>Add New Product</span>
            </Button>
          </div>
        }
      />

      {/* KPI Metrics Cards */}
      <div className="kpi-grid-6">
        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Total Catalog
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--ink)' }}>
            {summary.total.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)' }}>All Shopify listings</span>
        </div>

        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--tone-success-fg)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Active Published
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--tone-success-fg)' }}>
            {summary.active.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--tone-success-fg)' }}>Live on storefront</span>
        </div>

        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--tone-warning-fg)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Draft Listings
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--tone-warning-fg)' }}>
            {summary.draft.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--tone-warning-fg)' }}>Unpublished edits</span>
        </div>

        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Archived
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--ink-secondary)' }}>
            {summary.archived.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)' }}>Inactive archive</span>
        </div>

        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--tone-danger-fg)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Sold Out (0 Stock)
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--tone-danger-fg)' }}>
            {summary.outOfStock.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--tone-danger-fg)' }}>Requires restocking</span>
        </div>

        <div className="surface-card">
          <div style={{ fontSize: '11px', color: 'var(--tone-info-fg)', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
            Warehouse Stock
          </div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--tone-info-fg)' }}>
            {summary.totalInventory.toLocaleString()}
          </div>
          <span style={{ fontSize: '11px', color: 'var(--tone-info-fg)' }}>Units in Surat Hub</span>
        </div>
      </div>

      {/* Main Catalog Panel */}
      <Panel>
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)', padding: '0 16px', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '4px', maxWidth: '100%', overflowX: 'auto' }}>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
              style={{
                padding: '12px 14px',
                fontSize: '12.5px',
                fontWeight: activeTab === 'all' ? 750 : 600,
                color: activeTab === 'all' ? 'var(--tone-info-fg)' : 'var(--muted)',
                borderBottom: activeTab === 'all' ? '2px solid var(--tone-info-fg)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
              }}
            >
              All Products ({summary.total})
            </button>

            <button
              type="button"
              className={`tab-btn ${activeTab === 'active' ? 'active' : ''}`}
              onClick={() => setActiveTab('active')}
              style={{
                padding: '12px 14px',
                fontSize: '12.5px',
                fontWeight: activeTab === 'active' ? 750 : 600,
                color: activeTab === 'active' ? 'var(--tone-success-fg)' : 'var(--muted)',
                borderBottom: activeTab === 'active' ? '2px solid var(--tone-success-fg)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
              }}
            >
              Active Online ({summary.active})
            </button>

            <button
              type="button"
              className={`tab-btn ${activeTab === 'draft' ? 'active' : ''}`}
              onClick={() => setActiveTab('draft')}
              style={{
                padding: '12px 14px',
                fontSize: '12.5px',
                fontWeight: activeTab === 'draft' ? 750 : 600,
                color: activeTab === 'draft' ? 'var(--tone-warning-fg)' : 'var(--muted)',
                borderBottom: activeTab === 'draft' ? '2px solid var(--tone-warning-fg)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
              }}
            >
              Drafts ({summary.draft})
            </button>

            <button
              type="button"
              className={`tab-btn ${activeTab === 'archived' ? 'active' : ''}`}
              onClick={() => setActiveTab('archived')}
              style={{
                padding: '12px 14px',
                fontSize: '12.5px',
                fontWeight: activeTab === 'archived' ? 750 : 600,
                color: activeTab === 'archived' ? 'var(--ink)' : 'var(--muted)',
                borderBottom: activeTab === 'archived' ? '2px solid var(--ink)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
              }}
            >
              Archived ({summary.archived})
            </button>

            <button
              type="button"
              className={`tab-btn ${activeTab === 'low_stock' ? 'active' : ''}`}
              onClick={() => setActiveTab('low_stock')}
              style={{
                padding: '12px 14px',
                fontSize: '12.5px',
                fontWeight: activeTab === 'low_stock' ? 750 : 600,
                color: activeTab === 'low_stock' ? 'var(--tone-danger-fg)' : 'var(--muted)',
                borderBottom: activeTab === 'low_stock' ? '2px solid var(--tone-danger-fg)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                background: 'transparent',
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: 'none',
              }}
            >
              Low / Sold Out ({summary.outOfStock + summary.lowStock})
            </button>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
            Showing <strong>{filteredProducts.length}</strong> listings
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div style={{ display: 'flex', gap: '12px', padding: '14px 16px', background: 'var(--canvas)', borderBottom: '1px solid var(--line)', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Search box */}
          <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: '380px' }}>
            <span style={{ position: 'absolute', left: '10px', top: '9px', color: '#94a3b8' }}>
              <Icon name="search" size={15} />
            </span>
            <input
              type="text"
              aria-label="Search products by title, SKU, or tags"
              placeholder="Search by title, SKU, or tags…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                height: '36px',
                padding: '0 32px 0 32px',
                border: '1px solid var(--border-strong)',
                borderRadius: '7px',
                fontSize: '12.5px',
                background: 'var(--panel)',
                color: 'var(--ink)',
              }}
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: '8px', top: '8px', background: 'none', border: 'none', color: 'var(--muted)' }}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>

          {/* Product Type Filter */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: 'var(--muted)', fontWeight: 600 }}>Type:</span>
            <select
              aria-label="Filter by product type"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: '1px solid var(--border-strong)', fontSize: '12.5px', background: 'var(--panel)', color: 'var(--ink)' }}
            >
              {productTypes.map((t) => (
                <option key={t} value={t}>
                  {t === 'ALL' ? 'All Types' : t}
                </option>
              ))}
            </select>
          </label>

          {/* Sort By */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: 'var(--muted)', fontWeight: 600 }}>Sort:</span>
            <select
              aria-label="Sort products"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: '1px solid var(--border-strong)', fontSize: '12.5px', background: 'var(--panel)', color: 'var(--ink)' }}
            >
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="title">Title (A-Z)</option>
              <option value="stock_high">Highest Inventory</option>
              <option value="stock_low">Lowest Inventory</option>
            </select>
          </label>
        </div>

        {/* Products Table */}
        {productsQuery.isLoading ? (
          <div style={{ padding: '40px 0' }}>
            <LoadingState label="Loading product catalog from Shopify..." />
          </div>
        ) : productsQuery.isError ? (
          <div style={{ padding: '24px' }}>
            <ErrorBox message={apiError(productsQuery.error)} />
          </div>
        ) : filteredProducts.length === 0 ? (
          <div style={{ padding: '40px 20px' }}>
            <EmptyState
              title="No products match your criteria"
              description="Try adjusting your search terms or filters, or add a new product listing."
              icon="package"
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '48px' }}>Image</th>
                  <th>Product Title & Handle</th>
                  <th>Category / Vendor</th>
                  <th>Variants & Sizes</th>
                  <th>Price (₹)</th>
                  <th>Inventory</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((prod) => {
                  const firstImg = prod.images?.[0]?.src || prod.image?.src
                  const minPrice = prod.variants?.[0]?.price || '0'
                  const maxPrice = prod.variants?.[prod.variants.length - 1]?.price || minPrice
                  const compareAt = prod.variants?.[0]?.compare_at_price
                  const totalStock = prod.total_inventory ?? 0

                  return (
                    <tr key={prod.id}>
                      {/* Image Thumbnail */}
                      <td>
                        <div
                          style={{
                            width: '42px',
                            height: '42px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--surface-elevated)',
                            overflow: 'hidden',
                            display: 'grid',
                            placeItems: 'center',
                          }}
                        >
                          {firstImg ? (
                            <img
                              src={firstImg}
                              alt={prod.title}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              loading="lazy"
                            />
                          ) : (
                            <Icon name="package" size={18} />
                          )}
                        </div>
                      </td>

                      {/* Title & Store Preview */}
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <strong style={{ fontSize: '13px', color: 'var(--ink)' }}>{prod.title}</strong>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                              ID: <code style={{ fontSize: '10.5px' }}>{prod.id}</code>
                            </span>
                            {prod.handle && (
                              <a
                                href={`https://youthnic2024.myshopify.com/products/${prod.handle}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  fontSize: '10.5px',
                                  color: 'var(--tone-info-fg)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '2px',
                                  fontWeight: 600,
                                }}
                                title="View product live on storefront"
                              >
                                <span>Preview</span>
                                <Icon name="external" size={11} />
                              </a>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Type & Vendor */}
                      <td>
                        <span style={{ fontSize: '11.5px', color: 'var(--ink)', fontWeight: 600, display: 'block' }}>
                          {prod.product_type || 'Ethnic Wear'}
                        </span>
                        <span style={{ fontSize: '10.5px', color: 'var(--muted)' }}>{prod.vendor || 'Youthnic'}</span>
                      </td>

                      {/* Variants & Sizes */}
                      <td>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', maxWidth: '240px' }}>
                          {prod.variants?.slice(0, 5).map((v) => (
                            <span
                              key={v.id}
                              style={{
                                fontSize: '10px',
                                background: (v.inventory_quantity ?? 0) > 0 ? 'var(--tone-success-bg)' : 'var(--tone-danger-bg)',
                                color: (v.inventory_quantity ?? 0) > 0 ? 'var(--tone-success-fg)' : 'var(--tone-danger-fg)',
                                border: `1px solid ${(v.inventory_quantity ?? 0) > 0 ? 'var(--tone-success-border)' : 'var(--tone-danger-border)'}`,
                                padding: '1px 5px',
                                borderRadius: '4px',
                                fontWeight: 600,
                              }}
                              title={`${v.title}: ${v.inventory_quantity ?? 0} in stock`}
                            >
                              {v.title}: {v.inventory_quantity ?? 0}
                            </span>
                          ))}
                          {(prod.variants?.length ?? 0) > 5 && (
                            <span style={{ fontSize: '10px', color: 'var(--muted)' }}>
                              +{(prod.variants?.length ?? 0) - 5} more
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Price */}
                      <td>
                        <strong style={{ fontSize: '13px', color: 'var(--ink)' }}>
                          ₹{Number(minPrice).toLocaleString()}
                          {minPrice !== maxPrice && ` - ₹${Number(maxPrice).toLocaleString()}`}
                        </strong>
                        {compareAt && (
                          <div style={{ fontSize: '11px', color: 'var(--muted-light)', textDecoration: 'line-through' }}>
                            ₹{Number(compareAt).toLocaleString()}
                          </div>
                        )}
                      </td>

                      {/* Total Inventory */}
                      <td>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            className="status-badge"
                            style={{
                              background: totalStock > 10 ? 'var(--tone-success-bg)' : totalStock > 0 ? 'var(--tone-warning-bg)' : 'var(--tone-danger-bg)',
                              color: totalStock > 10 ? 'var(--tone-success-fg)' : totalStock > 0 ? 'var(--tone-warning-fg)' : 'var(--tone-danger-fg)',
                              borderColor: totalStock > 10 ? 'var(--tone-success-border)' : totalStock > 0 ? 'var(--tone-warning-border)' : 'var(--tone-danger-border)',
                            }}
                          >
                            <span
                              className="status-dot"
                              style={{
                                background: totalStock > 10 ? '#16a34a' : totalStock > 0 ? '#ca8a04' : '#dc2626',
                              }}
                            />
                            {totalStock > 0 ? `${totalStock} in stock` : 'Sold Out'}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleOpenStockAdjust(prod)}
                            className="btn-table-action"
                            style={{ padding: '2px 6px', fontSize: '10.5px' }}
                            title="Quick adjust inventory for this product"
                          >
                            Adjust
                          </button>
                        </div>
                      </td>

                      {/* Status Dropdown */}
                      <td>
                        <select
                          aria-label={`Change status for ${prod.title}`}
                          value={prod.status}
                          onChange={(e) =>
                            statusMutation.mutate({
                              id: prod.id,
                              status: e.target.value as 'active' | 'draft' | 'archived',
                            })
                          }
                          disabled={statusMutation.isPending}
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background:
                              prod.status === 'active'
                                ? 'var(--tone-success-bg)'
                                : prod.status === 'draft'
                                ? 'var(--tone-warning-bg)'
                                : 'var(--tone-neutral-bg)',
                            color:
                              prod.status === 'active'
                                ? 'var(--tone-success-fg)'
                                : prod.status === 'draft'
                                ? 'var(--tone-warning-fg)'
                                : 'var(--tone-neutral-fg)',
                            cursor: 'pointer',
                          }}
                        >
                          <option value="active">🟢 Active</option>
                          <option value="draft">🟡 Draft</option>
                          <option value="archived">⚪ Archived</option>
                        </select>
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px' }}>
                          <button
                            type="button"
                            className="btn-table-action"
                            onClick={() => setEditingProduct(prod)}
                            title="Edit product details, pricing & variants"
                          >
                            <Icon name="tool" size={13} />
                            <span>Edit</span>
                          </button>

                          <button
                            type="button"
                            className="btn-table-action danger"
                            onClick={() => setDeletingProduct(prod)}
                            title="Delete listing from Shopify"
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ─── ADD NEW PRODUCT MODAL ─────────────────────────────── */}
      {isAddModalOpen && (
        <AddProductModal
          onClose={() => setIsAddModalOpen(false)}
          onSubmit={(data) => createMutation.mutate(data)}
          isLoading={createMutation.isPending}
        />
      )}

      {/* ─── EDIT PRODUCT MODAL ─────────────────────────────────── */}
      {editingProduct && (
        <EditProductModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSubmit={(data) => updateMutation.mutate({ id: editingProduct.id, data })}
          isLoading={updateMutation.isPending}
        />
      )}

      {/* ─── QUICK STOCK ADJUSTMENT MODAL ───────────────────────── */}
      {stockAdjustProduct && (
        <div className="modal-backdrop" onClick={() => setStockAdjustProduct(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge" style={{ background: 'var(--tone-info-bg)', color: 'var(--tone-info-fg)' }}>
                  <Icon name="box" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">Adjust Warehouse Stock</h3>
                  <p className="modal-desc">{stockAdjustProduct.title}</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                aria-label="Close modal"
                onClick={() => setStockAdjustProduct(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="modal-body">
              <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: 'var(--muted)' }}>
                Updates available stock levels directly at the primary Surat Warehouse location (<code>70444449991</code>).
              </p>

              <div style={{ display: 'grid', gap: '8px' }}>
                {stockAdjustProduct.variants?.map((v) => {
                  const currentQty = variantStockInputs[v.id || 0] ?? v.inventory_quantity ?? 0
                  return (
                    <div
                      key={v.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        background: 'var(--surface-elevated)',
                        border: '1px solid var(--line)',
                        borderRadius: '8px',
                        gap: '10px',
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: '13px', color: 'var(--ink)' }}>{v.title}</strong>
                        <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block' }}>
                          SKU: {v.sku || 'N/A'} · Price: ₹{v.price}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          type="button"
                          aria-label={`Decrease quantity for ${v.title}`}
                          onClick={() =>
                            setVariantStockInputs((prev) => ({
                              ...prev,
                              [v.id || 0]: Math.max(0, currentQty - 1),
                            }))
                          }
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--panel)',
                            color: 'var(--ink)',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          -
                        </button>

                        <input
                          type="number"
                          min="0"
                          aria-label={`Quantity for ${v.title}`}
                          value={currentQty}
                          onChange={(e) =>
                            setVariantStockInputs((prev) => ({
                              ...prev,
                              [v.id || 0]: Math.max(0, parseInt(e.target.value, 10) || 0),
                            }))
                          }
                          style={{
                            width: '65px',
                            height: '32px',
                            textAlign: 'center',
                            fontWeight: 700,
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--panel)',
                            color: 'var(--ink)',
                          }}
                        />

                        <button
                          type="button"
                          aria-label={`Increase quantity for ${v.title}`}
                          onClick={() =>
                            setVariantStockInputs((prev) => ({
                              ...prev,
                              [v.id || 0]: currentQty + 1,
                            }))
                          }
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '6px',
                            border: '1px solid var(--line)',
                            background: 'var(--panel)',
                            color: 'var(--ink)',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setStockAdjustProduct(null)}
              >
                Cancel
              </button>
              <Button
                className="button-primary"
                style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
                onClick={handleSaveStockAdjust}
                loading={stockMutation.isPending}
              >
                Save Inventory Levels
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── DELETE PRODUCT CONFIRMATION MODAL ──────────────────── */}
      {deletingProduct && (
        <div className="modal-backdrop" onClick={() => setDeletingProduct(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div className="modal-header">
              <div className="modal-header-left">
                <div className="modal-icon-badge" style={{ background: '#fee2e2', color: '#dc2626' }}>
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <h3 className="modal-title">Delete Product Listing</h3>
                  <p className="modal-desc">Permanent removal confirmation</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                aria-label="Close modal"
                onClick={() => setDeletingProduct(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="modal-body">
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-secondary)' }}>
                Are you sure you want to delete <strong>{deletingProduct.title}</strong>?
              </p>
              <div style={{ marginTop: '12px', background: 'var(--tone-danger-bg)', border: '1px solid var(--tone-danger-border)', borderRadius: '8px', padding: '10px 12px', fontSize: '11.5px', color: 'var(--tone-danger-fg)' }}>
                This will permanently remove the product and all its variants from your Shopify store (<code>youthnic2024.myshopify.com</code>).
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn-cancel"
                onClick={() => setDeletingProduct(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={() => deleteMutation.mutate(deletingProduct.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete Permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   ADD PRODUCT MODAL COMPONENT
   ───────────────────────────────────────────────────────────── */
function AddProductModal({
  onClose,
  onSubmit,
  isLoading,
}: {
  onClose: () => void
  onSubmit: (data: CreateProductInput) => void
  isLoading: boolean
}) {
  const [title, setTitle] = useState('')
  const [vendor, setVendor] = useState('Youthnic')
  const [productType, setProductType] = useState('Kurtis')
  const [status, setStatus] = useState<'active' | 'draft'>('active')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('Ethnic Wear, New Arrival, 2026')
  const [imageUrl, setImageUrl] = useState('')
  const [imagesList, setImagesList] = useState<string[]>([])

  // Pricing & default variants
  const [price, setPrice] = useState('1499')
  const [compareAtPrice, setCompareAtPrice] = useState('2499')
  const [skuPrefix, setSkuPrefix] = useState('YN-')
  const [sizesInput, setSizesInput] = useState('S, M, L, XL, 2XL')
  const [defaultStock, setDefaultStock] = useState('25')

  const handleAddImage = () => {
    if (!imageUrl.trim()) return
    setImagesList((prev) => [...prev, imageUrl.trim()])
    setImageUrl('')
  }

  const handleRemoveImage = (idx: number) => {
    setImagesList((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    const sizes = sizesInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const variants = sizes.map((size) => ({
      title: size,
      option1: size,
      price: price.trim() || '1499',
      compare_at_price: compareAtPrice.trim() || null,
      sku: `${skuPrefix}${size}`,
      inventory_quantity: parseInt(defaultStock, 10) || 0,
      weight: 0.5,
      weight_unit: 'kg',
      requires_shipping: true,
    }))

    const images = imagesList.map((src, i) => ({
      src,
      position: i + 1,
      alt: title.trim(),
    }))

    onSubmit({
      title: title.trim(),
      vendor: vendor.trim(),
      product_type: productType.trim(),
      status,
      body_html: description.trim(),
      tags: tags.trim(),
      images,
      options: [{ name: 'Size', values: sizes }],
      variants,
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Create New Shopify Listing" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '680px' }}>
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" style={{ background: 'var(--tone-info-bg)', color: 'var(--tone-info-fg)' }}>
              <Icon name="plus" size={20} />
            </div>
            <div>
              <h3 className="modal-title">Create New Shopify Listing</h3>
              <p className="modal-desc">Publish directly to youthnic2024.myshopify.com</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" aria-label="Close modal" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ maxHeight: '72vh', overflowY: 'auto', display: 'grid', gap: '14px' }}>
            <FormField label="Product Title *">
              <input
                type="text"
                placeholder="e.g. Lavender Pure Cotton Printed Kurti Set"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </FormField>

            <div className="kpi-grid-3" style={{ gap: '10px' }}>
              <FormField label="Vendor">
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  style={{ width: '100%' }}
                />
              </FormField>

              <FormField label="Product Type">
                <input
                  type="text"
                  value={productType}
                  onChange={(e) => setProductType(e.target.value)}
                  style={{ width: '100%' }}
                />
              </FormField>

              <FormField label="Initial Status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                  style={{ width: '100%' }}
                >
                  <option value="active">🟢 Active (Live Online)</option>
                  <option value="draft">🟡 Draft (Unpublished)</option>
                </select>
              </FormField>
            </div>

            <FormField label="Product Description (HTML/Text)">
              <textarea
                rows={3}
                placeholder="Fabric details, wash care, design notes..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%' }}
              />
            </FormField>

            {/* Media / Images */}
            <div style={{ background: 'var(--surface-elevated)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--ink)', display: 'block', marginBottom: '6px' }}>
                Product Images (URLs)
              </span>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <input
                  type="url"
                  aria-label="Product image URL"
                  placeholder="https://cdn.shopify.com/s/files/... or image link"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  style={{ flex: 1, fontSize: '11.5px', height: '32px' }}
                />
                <button
                  type="button"
                  onClick={handleAddImage}
                  className="button-secondary"
                  style={{ height: '32px', padding: '0 12px', fontSize: '11.5px' }}
                >
                  + Add Image
                </button>
              </div>

              {imagesList.length > 0 && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {imagesList.map((img, i) => (
                    <div
                      key={i}
                      style={{
                        position: 'relative',
                        width: '54px',
                        height: '54px',
                        borderRadius: '6px',
                        border: '1px solid var(--line)',
                        overflow: 'hidden',
                      }}
                    >
                      <img src={img} alt="Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button
                        type="button"
                        aria-label={`Remove image ${i + 1}`}
                        onClick={() => handleRemoveImage(i)}
                        style={{
                          position: 'absolute',
                          top: 2,
                          right: 2,
                          background: 'rgba(0,0,0,0.6)',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '50%',
                          width: '18px',
                          height: '18px',
                          fontSize: '10px',
                          display: 'grid',
                          placeItems: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Options & Variants Generation */}
            <div style={{ background: 'var(--surface-elevated)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--ink)', display: 'block', marginBottom: '8px' }}>
                Pricing & Size Variants Generator
              </span>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '8px' }}>
                <FormField label="Selling Price (₹) *">
                  <input
                    type="number"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    required
                    style={{ width: '100%' }}
                  />
                </FormField>

                <FormField label="Compare-At / MRP (₹)">
                  <input
                    type="number"
                    value={compareAtPrice}
                    onChange={(e) => setCompareAtPrice(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </FormField>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '10px' }}>
                <FormField label="Sizes (Comma separated)">
                  <input
                    type="text"
                    value={sizesInput}
                    onChange={(e) => setSizesInput(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </FormField>

                <FormField label="SKU Prefix">
                  <input
                    type="text"
                    value={skuPrefix}
                    onChange={(e) => setSkuPrefix(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </FormField>

                <FormField label="Initial Stock / Size">
                  <input
                    type="number"
                    value={defaultStock}
                    onChange={(e) => setDefaultStock(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </FormField>
              </div>
            </div>

            <FormField label="Shopify Tags (Comma-separated)">
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                style={{ width: '100%' }}
              />
            </FormField>
          </div>

          <div className="modal-footer">
            <button type="button" className="modal-btn-cancel" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <Button
              className="button-primary"
              style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
              type="submit"
              loading={isLoading}
            >
              Publish to Shopify Store
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   EDIT PRODUCT MODAL COMPONENT
   ───────────────────────────────────────────────────────────── */
function EditProductModal({
  product,
  onClose,
  onSubmit,
  isLoading,
}: {
  product: ShopifyProduct
  onClose: () => void
  onSubmit: (data: UpdateProductInput) => void
  isLoading: boolean
}) {
  const [title, setTitle] = useState(product.title || '')
  const [vendor, setVendor] = useState(product.vendor || 'Youthnic')
  const [productType, setProductType] = useState(product.product_type || '')
  const [status, setStatus] = useState<'active' | 'draft' | 'archived'>(product.status || 'active')
  const [description, setDescription] = useState(product.body_html || '')
  const [tags, setTags] = useState(product.tags || '')

  // Variant editing: id -> { price, compare_at_price, inventory_quantity }
  const [variantUpdates, setVariantUpdates] = useState<
    Record<number, { price: string; compare_at_price?: string; inventory_quantity: number }>
  >(() => {
    const map: Record<number, any> = {}
    product.variants?.forEach((v) => {
      if (v.id) {
        map[v.id] = {
          price: v.price || '0',
          compare_at_price: v.compare_at_price || '',
          inventory_quantity: v.inventory_quantity || 0,
        }
      }
    })
    return map
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const variants = (product.variants || []).map((v) => {
      const up = v.id ? variantUpdates[v.id] : null
      return {
        id: v.id,
        price: up?.price || v.price,
        compare_at_price: up?.compare_at_price || v.compare_at_price || null,
        inventory_quantity: up?.inventory_quantity !== undefined ? up.inventory_quantity : v.inventory_quantity,
      }
    })

    onSubmit({
      title: title.trim(),
      vendor: vendor.trim(),
      product_type: productType.trim(),
      status,
      body_html: description,
      tags: tags.trim(),
      variants,
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={`Edit Listing: ${product.title}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: '680px' }}>
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" style={{ background: 'var(--tone-info-bg)', color: 'var(--tone-info-fg)' }}>
              <Icon name="tool" size={20} />
            </div>
            <div>
              <h3 className="modal-title">Edit Listing: {product.title}</h3>
              <p className="modal-desc">Shopify ID: {product.id}</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" aria-label="Close modal" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ maxHeight: '72vh', overflowY: 'auto', display: 'grid', gap: '14px' }}>
            <FormField label="Product Title *">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </FormField>

            <div className="kpi-grid-3" style={{ gap: '10px' }}>
              <FormField label="Vendor">
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  style={{ width: '100%' }}
                />
              </FormField>

              <FormField label="Product Type">
                <input
                  type="text"
                  value={productType}
                  onChange={(e) => setProductType(e.target.value)}
                  style={{ width: '100%' }}
                />
              </FormField>

              <FormField label="Listing Status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                  style={{ width: '100%' }}
                >
                  <option value="active">Active (Live Online)</option>
                  <option value="draft">Draft (Unpublished)</option>
                  <option value="archived">Archived</option>
                </select>
              </FormField>
            </div>

            <FormField label="Description (HTML/Text)">
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%' }}
              />
            </FormField>

            {/* Variants table */}
            <div style={{ background: 'var(--surface-elevated)', border: '1px solid var(--line)', borderRadius: '8px', padding: '12px' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--ink)', display: 'block', marginBottom: '8px' }}>
                Variants, Pricing & Stock
              </span>

              <div style={{ display: 'grid', gap: '8px' }}>
                {product.variants?.map((v) => {
                  const state = v.id ? variantUpdates[v.id] : null
                  return (
                    <div
                      key={v.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
                        gap: '8px',
                        alignItems: 'center',
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        borderRadius: '6px',
                        padding: '8px 10px',
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: '12px', color: 'var(--ink)' }}>{v.title}</strong>
                        <span style={{ fontSize: '10px', color: 'var(--muted)', display: 'block' }}>SKU: {v.sku || 'N/A'}</span>
                      </div>

                      <div>
                        <label style={{ fontSize: '9.5px', color: 'var(--muted)', display: 'block' }}>Price (₹)</label>
                        <input
                          type="number"
                          value={state?.price ?? v.price}
                          onChange={(e) =>
                            v.id &&
                            setVariantUpdates((prev) => ({
                              ...prev,
                              [v.id!]: { ...prev[v.id!], price: e.target.value },
                            }))
                          }
                          style={{ width: '100%', height: '26px', fontSize: '11.5px' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '9.5px', color: 'var(--muted)', display: 'block' }}>MRP (₹)</label>
                        <input
                          type="number"
                          value={state?.compare_at_price ?? v.compare_at_price ?? ''}
                          onChange={(e) =>
                            v.id &&
                            setVariantUpdates((prev) => ({
                              ...prev,
                              [v.id!]: { ...prev[v.id!], compare_at_price: e.target.value },
                            }))
                          }
                          style={{ width: '100%', height: '26px', fontSize: '11.5px' }}
                        />
                      </div>

                      <div>
                        <label style={{ fontSize: '9.5px', color: 'var(--muted)', display: 'block' }}>Stock</label>
                        <input
                          type="number"
                          value={state?.inventory_quantity ?? v.inventory_quantity ?? 0}
                          onChange={(e) =>
                            v.id &&
                            setVariantUpdates((prev) => ({
                              ...prev,
                              [v.id!]: { ...prev[v.id!], inventory_quantity: parseInt(e.target.value, 10) || 0 },
                            }))
                          }
                          style={{ width: '100%', height: '26px', fontSize: '11.5px', fontWeight: 700 }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <FormField label="Tags">
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                style={{ width: '100%' }}
              />
            </FormField>
          </div>

          <div className="modal-footer">
            <button type="button" className="modal-btn-cancel" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <Button
              className="button-primary"
              style={{ background: '#2563eb', borderColor: '#1d4ed8' }}
              type="submit"
              loading={isLoading}
            >
              Update Shopify Listing
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
