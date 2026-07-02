'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { slugify } from '@/lib/utils'
import { geocodeZip } from '@/lib/geocoding'
import { calculateHealthScore } from '@/lib/assets/health-score'
import { logAuditEvent } from '@/lib/audit'
import { applyMasterChecklistToProperty } from '@/lib/checklists/apply-master-template'
import type { AssetType } from '@/types/database'

export type PropertyActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  success?: boolean
}

// ── Create ──────────────────────────────────────────────────

export async function createProperty(
  _prev: PropertyActionState | null,
  formData: FormData
): Promise<PropertyActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const address       = (formData.get('address') as string)?.trim()
  const city          = (formData.get('city') as string)?.trim()
  const state         = (formData.get('state') as string)?.trim()
  const zip           = (formData.get('zip') as string)?.trim()
  const property_type = formData.get('property_type') as string || 'house'
  const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
  const bathrooms     = parseFloat(formData.get('bathrooms') as string) || 1
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = (formData.get('checkin_time') as string) || '15:00'
  const checkout_time = (formData.get('checkout_time') as string) || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code        = (formData.get('door_code') as string)?.trim() || null
  const internal_notes   = (formData.get('internal_notes') as string)?.trim() || null
  const avg_nightly_rate = formData.get('avg_nightly_rate')
    ? parseFloat(formData.get('avg_nightly_rate') as string)
    : null

  if (!name) return { error: 'Property name is required' }

  // Check plan property limit
  const { count } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

  if ((count ?? 0) >= membership.org.max_properties) {
    return {
      error: `Your plan allows up to ${membership.org.max_properties} properties. Upgrade to add more.`,
    }
  }

  const { data: property, error } = await supabase
    .from('properties')
    .insert({
      org_id:         membership.org_id,
      name,
      address:        address || null,
      city:           city || null,
      state:          state || null,
      zip:            zip || null,
      property_type,
      bedrooms,
      bathrooms,
      max_guests,
      checkin_time,
      checkout_time,
      wifi_name,
      wifi_password,
      door_code,
      internal_notes,
      avg_nightly_rate,
      setup_steps_completed: { details: true },
    })
    .select('id')
    .single()

  if (error) {
    console.error('[createProperty]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  if (zip) {
    const coords = await geocodeZip(zip)
    if (coords) {
      await supabase.from('properties').update({ lat: coords.lat, lng: coords.lng }).eq('id', property.id)
    } else {
      console.warn('[createProperty] geocodeZip returned null for zip:', zip)
    }
  }

  await applyMasterChecklistToProperty(property.id, membership.org_id, supabase, {
    force:   false,
    actorId: user.id,
  })

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.created',
    targetType: 'property',
    targetId:   property.id,
    metadata:   { name },
  })

  revalidatePath('/properties')
  redirect(`/properties/${property.id}/setup/details`)
}

// ── Update ───────────────────────────────────────────────────

export async function updateProperty(
  propertyId: string,
  _prev: PropertyActionState | null,
  formData: FormData
): Promise<PropertyActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const name          = (formData.get('name') as string)?.trim()
  const address       = (formData.get('address') as string)?.trim()
  const city          = (formData.get('city') as string)?.trim()
  const state         = (formData.get('state') as string)?.trim()
  const zip           = (formData.get('zip') as string)?.trim()
  const property_type = formData.get('property_type') as string || 'house'
  const bedrooms      = parseInt(formData.get('bedrooms') as string) || 1
  const bathrooms     = parseFloat(formData.get('bathrooms') as string) || 1
  const max_guests    = parseInt(formData.get('max_guests') as string) || 2
  const checkin_time  = (formData.get('checkin_time') as string) || '15:00'
  const checkout_time = (formData.get('checkout_time') as string) || '11:00'
  const wifi_name     = (formData.get('wifi_name') as string)?.trim() || null
  const wifi_password = (formData.get('wifi_password') as string)?.trim() || null
  const door_code     = (formData.get('door_code') as string)?.trim() || null
  const internal_notes = (formData.get('internal_notes') as string)?.trim() || null

  if (!name) return { error: 'Property name is required' }

  const { data: existing } = await supabase
    .from('properties')
    .select('zip')
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)
    .single()

  const { error } = await supabase
    .from('properties')
    .update({
      name, address: address || null, city: city || null,
      state: state || null, zip: zip || null,
      property_type, bedrooms, bathrooms, max_guests,
      checkin_time, checkout_time, wifi_name,
      wifi_password, door_code, internal_notes,
    })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[updateProperty]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  if (zip && zip !== (existing?.zip ?? '')) {
    const coords = await geocodeZip(zip)
    if (coords) {
      await supabase.from('properties').update({ lat: coords.lat, lng: coords.lng }).eq('id', propertyId)
    } else {
      console.warn('[updateProperty] geocodeZip returned null for zip:', zip)
    }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.updated',
    targetType: 'property',
    targetId:   propertyId,
  })

  revalidatePath(`/properties/${propertyId}`)
  return { success: true }
}

// ── Mark step complete ────────────────────────────────────────

export async function markStepComplete(
  propertyId: string,
  step: string
): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  // Fetch current steps
  const { data } = await supabase
    .from('properties')
    .select('setup_steps_completed')
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)
    .single()

  const current = (data?.setup_steps_completed as Record<string, boolean>) ?? {}
  const updated  = { ...current, [step]: true }

  await supabase
    .from('properties')
    .update({ setup_steps_completed: updated })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  const allSteps = ['details', 'ical', 'inventory', 'messages', 'checklist', 'maintenance', 'crew']
  const isFullySetup = allSteps.every((s) => updated[s] === true)

  if (isFullySetup) {
    const { data: props } = await supabase
      .from('properties')
      .select('id, setup_steps_completed')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)

    const fullyConfigured = (props ?? []).filter((p) => {
      const steps = p.setup_steps_completed as Record<string, boolean>
      return allSteps.every((s) => steps?.[s] === true)
    })

    if (fullyConfigured.length === 2) {
      await supabase.from('org_milestones').upsert(
        { org_id: membership.org_id, milestone: 'second_property_configured' },
        { onConflict: 'org_id,milestone', ignoreDuplicates: true }
      )
    }
  }

  revalidatePath(`/properties/${propertyId}`)
}

// ── Asset CRUD ───────────────────────────────────────────────

export type AssetActionState = { error?: string; success?: boolean }

export async function createAsset(
  propertyId: string,
  _prev: AssetActionState | null,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const name              = (formData.get('name') as string)?.trim()
    const asset_type        = formData.get('asset_type') as AssetType
    const make              = (formData.get('make') as string)?.trim() || null
    const model             = (formData.get('model') as string)?.trim() || null
    const serial_number     = (formData.get('serial_number') as string)?.trim() || null
    const installation_date = (formData.get('installation_date') as string) || null
    const purchase_price    = formData.get('purchase_price')
      ? parseFloat(formData.get('purchase_price') as string) : null
    const estimated_replacement_cost = formData.get('estimated_replacement_cost')
      ? parseFloat(formData.get('estimated_replacement_cost') as string) : null
    const warranty_expiry_date = (formData.get('warranty_expiry_date') as string) || null
    const warranty_provider    = (formData.get('warranty_provider') as string)?.trim() || null
    const notes                = (formData.get('notes') as string)?.trim() || null
    const lifespan_raw         = formData.get('expected_lifespan_years')
    const expected_lifespan_years = lifespan_raw ? parseInt(lifespan_raw as string) : null

    if (!name)       return { error: 'Asset name is required' }
    if (!asset_type) return { error: 'Asset type is required' }

    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const { data: standards } = await supabase
      .from('asset_type_standards')
      .select('lifespan_min_years, lifespan_max_years, avg_replacement_cost_high, macrs_class_default')
      .eq('asset_type', asset_type)
      .single()

    const lifespan = expected_lifespan_years ?? (
      standards
        ? Math.round((standards.lifespan_min_years + standards.lifespan_max_years) / 2)
        : null
    )

    let health_score: number | null = null
    if (standards && installation_date) {
      health_score = calculateHealthScore(
        { installation_date, expected_lifespan_years: lifespan, estimated_replacement_cost },
        standards,
        { total_repairs: 0, total_repair_cost: 0, last_serviced_at: null },
      )
    }

    const { data: asset, error } = await supabase
      .from('property_assets')
      .insert({
        property_id:               propertyId,
        org_id:                    membership.org_id,
        name,
        asset_type,
        make,
        model,
        serial_number,
        installation_date,
        placed_in_service_date:    installation_date,
        purchase_price,
        estimated_replacement_cost,
        expected_lifespan_years:   lifespan,
        warranty_expiry_date,
        warranty_provider,
        notes,
        health_score,
        health_score_updated_at:   health_score !== null ? new Date().toISOString() : null,
        macrs_class:               standards?.macrs_class_default ?? '5_year',
        depreciation_method:       'macrs',
        salvage_value:             0,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[createAsset]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.created',
      targetType: 'property_asset',
      targetId:   asset?.id,
      metadata:   { property_id: propertyId, asset_type },
    })

    revalidatePath(`/properties/${propertyId}`)
    return { success: true }
  } catch (err) {
    console.error('[createAsset]', err)
    return { error: 'Failed to save asset' }
  }
}

export async function updateAsset(
  assetId: string,
  propertyId: string,
  _prev: AssetActionState | null,
  formData: FormData
): Promise<AssetActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const name              = (formData.get('name') as string)?.trim()
    const make              = (formData.get('make') as string)?.trim() || null
    const model             = (formData.get('model') as string)?.trim() || null
    const serial_number     = (formData.get('serial_number') as string)?.trim() || null
    const installation_date = (formData.get('installation_date') as string) || null
    const purchase_price    = formData.get('purchase_price')
      ? parseFloat(formData.get('purchase_price') as string) : null
    const estimated_replacement_cost = formData.get('estimated_replacement_cost')
      ? parseFloat(formData.get('estimated_replacement_cost') as string) : null
    const warranty_expiry_date = (formData.get('warranty_expiry_date') as string) || null
    const warranty_provider    = (formData.get('warranty_provider') as string)?.trim() || null
    const notes                = (formData.get('notes') as string)?.trim() || null
    const lifespan_raw         = formData.get('expected_lifespan_years')
    const expected_lifespan_years = lifespan_raw ? parseInt(lifespan_raw as string) : null

    if (!name) return { error: 'Asset name is required' }

    const { error } = await supabase
      .from('property_assets')
      .update({
        name, make, model, serial_number,
        installation_date, placed_in_service_date: installation_date,
        purchase_price, estimated_replacement_cost,
        expected_lifespan_years, warranty_expiry_date, warranty_provider, notes,
      })
      .eq('id', assetId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[updateAsset]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.updated',
      targetType: 'property_asset',
      targetId:   assetId,
      metadata:   { property_id: propertyId },
    })

    revalidatePath(`/properties/${propertyId}`)
    return { success: true }
  } catch (err) {
    console.error('[updateAsset]', err)
    return { error: 'Failed to update asset' }
  }
}

export async function deactivateAsset(assetId: string, propertyId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()
    await supabase
      .from('property_assets')
      .update({ is_active: false })
      .eq('id', assetId)
      .eq('org_id', membership.org_id)
    revalidatePath(`/properties/${propertyId}`)
    return {}
  } catch (err) {
    console.error('[deactivateAsset]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Bulk CSV asset import ─────────────────────────────────────

export interface CsvAssetRow {
  name:                      string
  asset_type:                string
  make:                      string | null
  model:                     string | null
  serial_number:             string | null
  installation_date:         string | null
  purchase_price:            number | null
  estimated_replacement_cost: number | null
  warranty_expiry_date:      string | null
  warranty_provider:         string | null
  notes:                     string | null
}

export async function bulkImportAssets(
  propertyId: string,
  rows:       CsvAssetRow[],
): Promise<{ imported: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: standards } = await supabase
      .from('asset_type_standards')
      .select('asset_type, macrs_class_default, lifespan_min_years, lifespan_max_years')

    const stdMap = Object.fromEntries((standards ?? []).map((s) => [s.asset_type, s]))

    const insertRows = rows.map((row) => {
      const std = stdMap[row.asset_type]
      return {
        org_id:                     membership.org_id,
        property_id:                propertyId,
        name:                       row.name,
        asset_type:                 row.asset_type,
        make:                       row.make,
        model:                      row.model,
        serial_number:              row.serial_number,
        installation_date:          row.installation_date,
        placed_in_service_date:     row.installation_date,
        purchase_price:             row.purchase_price,
        estimated_replacement_cost: row.estimated_replacement_cost,
        warranty_expiry_date:       row.warranty_expiry_date,
        warranty_provider:          row.warranty_provider,
        notes:                      row.notes,
        macrs_class:                std?.macrs_class_default ?? '5_year',
        expected_lifespan_years:    std
          ? Math.round((std.lifespan_min_years + std.lifespan_max_years) / 2)
          : null,
        depreciation_method:       'macrs',
        salvage_value:             0,
        is_active:                 true,
        setup_steps_completed:     {},
      }
    })

    const { error } = await supabase.from('property_assets').insert(insertRows)
    if (error) {
      console.error('[bulkImportAssets]', error)
      return { imported: 0, error: 'Import failed — please try again' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'asset.bulk_imported',
      targetType: 'property_asset',
      targetId:   propertyId,
      metadata:   { count: rows.length, property_id: propertyId },
    })

    revalidatePath(`/properties/${propertyId}`)
    return { imported: rows.length }
  } catch (err) {
    console.error('[bulkImportAssets]', err)
    return { imported: 0, error: 'Import failed — please try again' }
  }
}

// ── Archive ──────────────────────────────────────────────────

export async function archiveProperty(propertyId: string): Promise<void> {
  const { supabase, membership, user } = await requireOrgMember()

  await supabase
    .from('properties')
    .update({ is_active: false })
    .eq('id', propertyId)
    .eq('org_id', membership.org_id)

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.archived',
    targetType: 'property',
    targetId:   propertyId,
  })

  revalidatePath('/properties')
  redirect('/properties')
}
