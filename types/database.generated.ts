/**
 * FieldStay — Generated Supabase Types (Reference)
 *
 * Auto-generated from the live Supabase project (vpmznjktllhmmbfnxuvk)
 * via the Supabase MCP generate_typescript_types tool on 2026-06-10.
 *
 * This file is NOT imported anywhere in the app. types/database.ts is the
 * hand-maintained file that the codebase actually imports from (flat
 * per-table interfaces). Use this file as a drift-check reference: when
 * adding/changing columns, cross-check the Row/Insert/Update shapes here
 * against types/database.ts to make sure the hand-written types match the
 * live schema.
 *
 * Do not import from this file. Regenerate by re-running
 * generate_typescript_types against vpmznjktllhmmbfnxuvk.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      asset_depreciation_entries: {
        Row: {
          asset_id: string
          cost_basis: number
          current_year_depreciation: number
          depreciation_rate: number | null
          ending_adjusted_basis: number
          generated_at: string
          id: string
          macrs_class: Database["public"]["Enums"]["macrs_class"]
          notes: string | null
          org_id: string
          prior_cumulative_depreciation: number
          tax_year: number
        }
        Insert: {
          asset_id: string
          cost_basis: number
          current_year_depreciation: number
          depreciation_rate?: number | null
          ending_adjusted_basis: number
          generated_at?: string
          id?: string
          macrs_class: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          org_id: string
          prior_cumulative_depreciation?: number
          tax_year: number
        }
        Update: {
          asset_id?: string
          cost_basis?: number
          current_year_depreciation?: number
          depreciation_rate?: number | null
          ending_adjusted_basis?: number
          generated_at?: string
          id?: string
          macrs_class?: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          org_id?: string
          prior_cumulative_depreciation?: number
          tax_year?: number
        }
        Relationships: [
          {
            foreignKeyName: "asset_depreciation_entries_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_type_standards: {
        Row: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high: number | null
          avg_replacement_cost_low: number | null
          display_name: string
          lifespan_max_years: number
          lifespan_min_years: number
          macrs_class_default: Database["public"]["Enums"]["macrs_class"]
          notes: string | null
          vendor_specialty_default:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Insert: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high?: number | null
          avg_replacement_cost_low?: number | null
          display_name: string
          lifespan_max_years: number
          lifespan_min_years: number
          macrs_class_default?: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          vendor_specialty_default?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Update: {
          asset_type?: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high?: number | null
          avg_replacement_cost_low?: number | null
          display_name?: string
          lifespan_max_years?: number
          lifespan_min_years?: number
          macrs_class_default?: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          vendor_specialty_default?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Relationships: []
      }
      assignment_outcomes: {
        Row: {
          completed_at: string | null
          created_at: string
          crew_member_id: string
          duration_minutes: number | null
          id: string
          org_id: string
          override_reason: string | null
          pm_rating: number | null
          property_bedrooms: number | null
          property_id: string | null
          score_breakdown: Json | null
          started_at: string | null
          suggested_score: number | null
          turnover_id: string
          was_accepted: boolean | null
          was_suggestion: boolean
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          crew_member_id: string
          duration_minutes?: number | null
          id?: string
          org_id: string
          override_reason?: string | null
          pm_rating?: number | null
          property_bedrooms?: number | null
          property_id?: string | null
          score_breakdown?: Json | null
          started_at?: string | null
          suggested_score?: number | null
          turnover_id: string
          was_accepted?: boolean | null
          was_suggestion?: boolean
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          crew_member_id?: string
          duration_minutes?: number | null
          id?: string
          org_id?: string
          override_reason?: string | null
          pm_rating?: number | null
          property_bedrooms?: number | null
          property_id?: string | null
          score_breakdown?: Json | null
          started_at?: string | null
          suggested_score?: number | null
          turnover_id?: string
          was_accepted?: boolean | null
          was_suggestion?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "assignment_outcomes_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_outcomes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignment_outcomes_turnover_id_fkey"
            columns: ["turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          ip_address: string | null
          metadata: Json | null
          org_id: string | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          org_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          org_id?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          checkin_date: string
          checkin_time: string | null
          checkout_date: string
          checkout_time: string | null
          created_at: string
          external_id: string | null
          external_source: string | null
          guest_email: string | null
          guest_name: string | null
          ical_feed_id: string | null
          ical_uid: string | null
          id: string
          notes: string | null
          org_id: string
          property_id: string
          raw_ical_data: Json | null
          source: Database["public"]["Enums"]["booking_source"] | null
          status: Database["public"]["Enums"]["booking_status"]
          updated_at: string
        }
        Insert: {
          checkin_date: string
          checkin_time?: string | null
          checkout_date: string
          checkout_time?: string | null
          created_at?: string
          external_id?: string | null
          external_source?: string | null
          guest_email?: string | null
          guest_name?: string | null
          ical_feed_id?: string | null
          ical_uid?: string | null
          id?: string
          notes?: string | null
          org_id: string
          property_id: string
          raw_ical_data?: Json | null
          source?: Database["public"]["Enums"]["booking_source"] | null
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Update: {
          checkin_date?: string
          checkin_time?: string | null
          checkout_date?: string
          checkout_time?: string | null
          created_at?: string
          external_id?: string | null
          external_source?: string | null
          guest_email?: string | null
          guest_name?: string | null
          ical_feed_id?: string | null
          ical_uid?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          property_id?: string
          raw_ical_data?: Json | null
          source?: Database["public"]["Enums"]["booking_source"] | null
          status?: Database["public"]["Enums"]["booking_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_ical_feed_id_fkey"
            columns: ["ical_feed_id"]
            isOneToOne: false
            referencedRelation: "ical_feeds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_instance_items: {
        Row: {
          completed_at: string | null
          completed_by_crew_id: string | null
          created_at: string
          crew_notes: string | null
          id: string
          instance_id: string
          is_completed: boolean
          is_section_final_item: boolean
          notes: string | null
          photo_storage_path: string | null
          requires_photo: boolean
          section_name: string
          sort_order: number
          task: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          crew_notes?: string | null
          id?: string
          instance_id: string
          is_completed?: boolean
          is_section_final_item?: boolean
          notes?: string | null
          photo_storage_path?: string | null
          requires_photo?: boolean
          section_name: string
          sort_order?: number
          task: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          crew_notes?: string | null
          id?: string
          instance_id?: string
          is_completed?: boolean
          is_section_final_item?: boolean
          notes?: string | null
          photo_storage_path?: string | null
          requires_photo?: boolean
          section_name?: string
          sort_order?: number
          task?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_instance_items_completed_by_crew_id_fkey"
            columns: ["completed_by_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_instance_items_instance_id_fkey"
            columns: ["instance_id"]
            isOneToOne: false
            referencedRelation: "checklist_instances"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_instances: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          org_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["checklist_status"]
          template_id: string | null
          template_snapshot: Json
          turnover_id: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          org_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["checklist_status"]
          template_id?: string | null
          template_snapshot: Json
          turnover_id: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          org_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["checklist_status"]
          template_id?: string | null
          template_snapshot?: Json
          turnover_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_instances_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_instances_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_instances_turnover_id_fkey"
            columns: ["turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_template_items: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          requires_photo: boolean
          section_id: string
          sort_order: number
          task: string
          template_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          requires_photo?: boolean
          section_id: string
          sort_order?: number
          task: string
          template_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          requires_photo?: boolean
          section_id?: string
          sort_order?: number
          task?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_template_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "checklist_template_sections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_template_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_template_sections: {
        Row: {
          created_at: string
          id: string
          name: string
          requires_section_photo: boolean
          sort_order: number
          template_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          requires_section_photo?: boolean
          sort_order?: number
          template_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          requires_section_photo?: boolean
          sort_order?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_template_sections_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_default: boolean
          name: string
          org_id: string
          property_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          org_id: string
          property_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          org_id?: string
          property_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      communication_logs: {
        Row: {
          body: string | null
          channel: Database["public"]["Enums"]["comm_channel"]
          communicated_at: string
          created_at: string
          crew_member_id: string | null
          deleted_at: string | null
          id: string
          logged_by_user_id: string | null
          org_id: string
          property_id: string | null
          recipient_type: Database["public"]["Enums"]["comm_recipient_type"]
          source: Database["public"]["Enums"]["comm_source"]
          subject: string | null
          vendor_id: string | null
          work_order_id: string | null
        }
        Insert: {
          body?: string | null
          channel?: Database["public"]["Enums"]["comm_channel"]
          communicated_at?: string
          created_at?: string
          crew_member_id?: string | null
          deleted_at?: string | null
          id?: string
          logged_by_user_id?: string | null
          org_id: string
          property_id?: string | null
          recipient_type: Database["public"]["Enums"]["comm_recipient_type"]
          source?: Database["public"]["Enums"]["comm_source"]
          subject?: string | null
          vendor_id?: string | null
          work_order_id?: string | null
        }
        Update: {
          body?: string | null
          channel?: Database["public"]["Enums"]["comm_channel"]
          communicated_at?: string
          created_at?: string
          crew_member_id?: string | null
          deleted_at?: string | null
          id?: string
          logged_by_user_id?: string | null
          org_id?: string
          property_id?: string | null
          recipient_type?: Database["public"]["Enums"]["comm_recipient_type"]
          source?: Database["public"]["Enums"]["comm_source"]
          subject?: string | null
          vendor_id?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "communication_logs_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communication_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communication_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communication_logs_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "communication_logs_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communication_logs_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_availability: {
        Row: {
          available_date: string
          created_at: string
          crew_member_id: string
          id: string
          is_available: boolean
          notes: string | null
          org_id: string
        }
        Insert: {
          available_date: string
          created_at?: string
          crew_member_id: string
          id?: string
          is_available?: boolean
          notes?: string | null
          org_id: string
        }
        Update: {
          available_date?: string
          created_at?: string
          crew_member_id?: string
          id?: string
          is_available?: boolean
          notes?: string | null
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crew_availability_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_members: {
        Row: {
          capacity_score: number
          created_at: string
          email: string | null
          home_lat: number | null
          home_lng: number | null
          id: string
          invite_accepted_at: string | null
          invite_sent_at: string | null
          invite_token: string | null
          is_active: boolean
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          preferred_contact: Database["public"]["Enums"]["contact_pref"] | null
          reliability_score: number
          role: Database["public"]["Enums"]["crew_role"]
          sms_carrier: string | null
          specialty: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          capacity_score?: number
          created_at?: string
          email?: string | null
          home_lat?: number | null
          home_lng?: number | null
          id?: string
          invite_accepted_at?: string | null
          invite_sent_at?: string | null
          invite_token?: string | null
          is_active?: boolean
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          preferred_contact?: Database["public"]["Enums"]["contact_pref"] | null
          reliability_score?: number
          role?: Database["public"]["Enums"]["crew_role"]
          sms_carrier?: string | null
          specialty?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          capacity_score?: number
          created_at?: string
          email?: string | null
          home_lat?: number | null
          home_lng?: number | null
          id?: string
          invite_accepted_at?: string | null
          invite_sent_at?: string | null
          invite_token?: string | null
          is_active?: boolean
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          preferred_contact?: Database["public"]["Enums"]["contact_pref"] | null
          reliability_score?: number
          role?: Database["public"]["Enums"]["crew_role"]
          sms_carrier?: string | null
          specialty?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crew_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_message_templates: {
        Row: {
          body: string
          created_at: string
          days_before: number | null
          id: string
          is_active: boolean
          name: string
          org_id: string
          property_id: string
          subject: string
          trigger: Database["public"]["Enums"]["message_trigger"]
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          days_before?: number | null
          id?: string
          is_active?: boolean
          name: string
          org_id: string
          property_id: string
          subject: string
          trigger: Database["public"]["Enums"]["message_trigger"]
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          days_before?: number | null
          id?: string
          is_active?: boolean
          name?: string
          org_id?: string
          property_id?: string
          subject?: string
          trigger?: Database["public"]["Enums"]["message_trigger"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_message_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_message_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_messages_sent: {
        Row: {
          body_rendered: string
          booking_id: string | null
          created_at: string
          id: string
          org_id: string
          property_id: string
          recipient_email: string
          recipient_name: string | null
          resend_message_id: string | null
          sent_at: string
          status: Database["public"]["Enums"]["message_status"]
          subject: string
          template_id: string | null
          trigger: Database["public"]["Enums"]["message_trigger"]
        }
        Insert: {
          body_rendered: string
          booking_id?: string | null
          created_at?: string
          id?: string
          org_id: string
          property_id: string
          recipient_email: string
          recipient_name?: string | null
          resend_message_id?: string | null
          sent_at?: string
          status?: Database["public"]["Enums"]["message_status"]
          subject: string
          template_id?: string | null
          trigger: Database["public"]["Enums"]["message_trigger"]
        }
        Update: {
          body_rendered?: string
          booking_id?: string | null
          created_at?: string
          id?: string
          org_id?: string
          property_id?: string
          recipient_email?: string
          recipient_name?: string | null
          resend_message_id?: string | null
          sent_at?: string
          status?: Database["public"]["Enums"]["message_status"]
          subject?: string
          template_id?: string | null
          trigger?: Database["public"]["Enums"]["message_trigger"]
        }
        Relationships: [
          {
            foreignKeyName: "guest_messages_sent_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_messages_sent_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_messages_sent_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_messages_sent_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "guest_message_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      ical_feeds: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          last_sync_error: string | null
          last_sync_status: Database["public"]["Enums"]["sync_status"] | null
          last_synced_at: string | null
          name: string
          org_id: string
          property_id: string
          source: Database["public"]["Enums"]["ical_source"] | null
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_sync_error?: string | null
          last_sync_status?: Database["public"]["Enums"]["sync_status"] | null
          last_synced_at?: string | null
          name: string
          org_id: string
          property_id: string
          source?: Database["public"]["Enums"]["ical_source"] | null
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_sync_error?: string | null
          last_sync_status?: Database["public"]["Enums"]["sync_status"] | null
          last_synced_at?: string | null
          name?: string
          org_id?: string
          property_id?: string
          source?: Database["public"]["Enums"]["ical_source"] | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "ical_feeds_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ical_feeds_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_connections: {
        Row: {
          connected_at: string
          created_at: string
          external_user_id: string | null
          id: string
          last_used_at: string | null
          metadata: Json
          provider_id: string
          scope: string | null
          status: string
          updated_at: string
          user_id: string
          vault_secret_id: string | null
        }
        Insert: {
          connected_at?: string
          created_at?: string
          external_user_id?: string | null
          id?: string
          last_used_at?: string | null
          metadata?: Json
          provider_id: string
          scope?: string | null
          status?: string
          updated_at?: string
          user_id: string
          vault_secret_id?: string | null
        }
        Update: {
          connected_at?: string
          created_at?: string
          external_user_id?: string | null
          id?: string
          last_used_at?: string | null
          metadata?: Json
          provider_id?: string
          scope?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          vault_secret_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_connections_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "integration_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_providers: {
        Row: {
          auth_type: string
          created_at: string
          display_name: string
          id: string
          is_active: boolean
        }
        Insert: {
          auth_type: string
          created_at?: string
          display_name: string
          id: string
          is_active?: boolean
        }
        Update: {
          auth_type?: string
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
        }
        Relationships: []
      }
      inventory_catalog: {
        Row: {
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          default_unit: string
          description: string | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      inventory_count_draft_items: {
        Row: {
          counted_qty: number
          draft_id: string
          id: string
          item_id: string
          note: string | null
        }
        Insert: {
          counted_qty?: number
          draft_id: string
          id?: string
          item_id: string
          note?: string | null
        }
        Update: {
          counted_qty?: number
          draft_id?: string
          id?: string
          item_id?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_count_draft_items_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "inventory_count_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_count_draft_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_count_drafts: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          org_id: string
          property_id: string
          status: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id: string
          property_id: string
          status?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          property_id?: string
          status?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_count_drafts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_count_items: {
        Row: {
          count_id: string
          created_at: string
          id: string
          inventory_item_id: string
          quantity_counted: number
        }
        Insert: {
          count_id: string
          created_at?: string
          id?: string
          inventory_item_id: string
          quantity_counted: number
        }
        Update: {
          count_id?: string
          created_at?: string
          id?: string
          inventory_item_id?: string
          quantity_counted?: number
        }
        Relationships: [
          {
            foreignKeyName: "inventory_count_items_count_id_fkey"
            columns: ["count_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_count_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_counts: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          org_id: string
          property_id: string
          submitted_at: string
          submitted_by_crew_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id: string
          property_id: string
          submitted_at?: string
          submitted_by_crew_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          property_id?: string
          submitted_at?: string
          submitted_by_crew_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_submitted_by_crew_id_fkey"
            columns: ["submitted_by_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          catalog_item_id: string | null
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          current_quantity: number
          id: string
          is_active: boolean
          low_stock_threshold_pct: number
          name: string
          notes: string | null
          org_id: string
          par_level: number
          preferred_brand: string | null
          property_id: string
          unit: string
          updated_at: string
        }
        Insert: {
          catalog_item_id?: string | null
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          current_quantity?: number
          id?: string
          is_active?: boolean
          low_stock_threshold_pct?: number
          name: string
          notes?: string | null
          org_id: string
          par_level?: number
          preferred_brand?: string | null
          property_id: string
          unit?: string
          updated_at?: string
        }
        Update: {
          catalog_item_id?: string | null
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          current_quantity?: number
          id?: string
          is_active?: boolean
          low_stock_threshold_pct?: number
          name?: string
          notes?: string | null
          org_id?: string
          par_level?: number
          preferred_brand?: string | null
          property_id?: string
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_catalog_item_id_fkey"
            columns: ["catalog_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_template_items: {
        Row: {
          category: string | null
          id: string
          name: string
          par_level: number
          par_qty: number
          preferred_brand: string | null
          sort_order: number
          template_id: string
          unit: string | null
        }
        Insert: {
          category?: string | null
          id?: string
          name: string
          par_level?: number
          par_qty?: number
          preferred_brand?: string | null
          sort_order?: number
          template_id: string
          unit?: string | null
        }
        Update: {
          category?: string | null
          id?: string
          name?: string
          par_level?: number
          par_qty?: number
          preferred_brand?: string | null
          sort_order?: number
          template_id?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_template_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "inventory_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          org_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          org_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          org_id?: string
        }
        Relationships: []
      }
      maintenance_schedule_template_items: {
        Row: {
          created_at: string
          description: string | null
          estimated_cost: number | null
          id: string
          is_optional_flag: string | null
          name: string
          schedule_frequency: Database["public"]["Enums"]["schedule_frequency"]
          sort_order: number
          template_id: string
          vendor_specialty_hint:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          id?: string
          is_optional_flag?: string | null
          name: string
          schedule_frequency: Database["public"]["Enums"]["schedule_frequency"]
          sort_order?: number
          template_id: string
          vendor_specialty_hint?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Update: {
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          id?: string
          is_optional_flag?: string | null
          name?: string
          schedule_frequency?: Database["public"]["Enums"]["schedule_frequency"]
          sort_order?: number
          template_id?: string
          vendor_specialty_hint?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_schedule_template_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "maintenance_schedule_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_schedule_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          name: string
          org_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          org_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          org_id?: string
        }
        Relationships: []
      }
      maintenance_schedules: {
        Row: {
          assigned_vendor_id: string | null
          auto_create_wo: boolean
          created_at: string
          day_of_month_due: number | null
          description: string | null
          estimated_cost: number | null
          frequency: Database["public"]["Enums"]["schedule_frequency"] | null
          id: string
          instructions: string | null
          is_active: boolean
          last_completed_date: string | null
          month_due: number | null
          name: string
          next_due_date: string | null
          org_id: string
          property_id: string
          schedule_type: Database["public"]["Enums"]["schedule_type"]
          updated_at: string
          vendor_specialty_hint:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Insert: {
          assigned_vendor_id?: string | null
          auto_create_wo?: boolean
          created_at?: string
          day_of_month_due?: number | null
          description?: string | null
          estimated_cost?: number | null
          frequency?: Database["public"]["Enums"]["schedule_frequency"] | null
          id?: string
          instructions?: string | null
          is_active?: boolean
          last_completed_date?: string | null
          month_due?: number | null
          name: string
          next_due_date?: string | null
          org_id: string
          property_id: string
          schedule_type?: Database["public"]["Enums"]["schedule_type"]
          updated_at?: string
          vendor_specialty_hint?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Update: {
          assigned_vendor_id?: string | null
          auto_create_wo?: boolean
          created_at?: string
          day_of_month_due?: number | null
          description?: string | null
          estimated_cost?: number | null
          frequency?: Database["public"]["Enums"]["schedule_frequency"] | null
          id?: string
          instructions?: string | null
          is_active?: boolean
          last_completed_date?: string | null
          month_due?: number | null
          name?: string
          next_due_date?: string | null
          org_id?: string
          property_id?: string
          schedule_type?: Database["public"]["Enums"]["schedule_type"]
          updated_at?: string
          vendor_specialty_hint?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_schedules_assigned_vendor_id_fkey"
            columns: ["assigned_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "maintenance_schedules_assigned_vendor_id_fkey"
            columns: ["assigned_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string
          id: string
          org_id: string
          read_at: string | null
          recipient_id: string
          sender_id: string
          turnover_id: string | null
          work_order_id: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          org_id: string
          read_at?: string | null
          recipient_id: string
          sender_id: string
          turnover_id?: string | null
          work_order_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          org_id?: string
          read_at?: string | null
          recipient_id?: string
          sender_id?: string
          turnover_id?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_turnover_id_fkey"
            columns: ["turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          provider_id: string
          return_to: string | null
          state: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string
          provider_id: string
          return_to?: string | null
          state: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          provider_id?: string
          return_to?: string | null
          state?: string
          user_id?: string | null
        }
        Relationships: []
      }
      pending_integration_links: {
        Row: {
          created_at: string
          external_user_id: string
          expires_at: string
          id: string
          metadata: Json
          pending_link_token: string
          provider_id: string
          refresh_token_vault_secret_id: string | null
          scope: string | null
          vault_secret_id: string
        }
        Insert: {
          created_at?: string
          external_user_id: string
          expires_at?: string
          id?: string
          metadata?: Json
          pending_link_token: string
          provider_id: string
          refresh_token_vault_secret_id?: string | null
          scope?: string | null
          vault_secret_id: string
        }
        Update: {
          created_at?: string
          external_user_id?: string
          expires_at?: string
          id?: string
          metadata?: Json
          pending_link_token?: string
          provider_id?: string
          refresh_token_vault_secret_id?: string | null
          scope?: string | null
          vault_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_integration_links_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "integration_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      org_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          org_id: string
          role: Database["public"]["Enums"]["member_role"]
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          org_id: string
          role?: Database["public"]["Enums"]["member_role"]
          token?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          org_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_master_checklist_items: {
        Row: {
          created_at: string
          id: string
          org_id: string
          section: string
          sort_order: number
          source: string
          task: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          section: string
          sort_order?: number
          source?: string
          task: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          section?: string
          sort_order?: number
          source?: string
          task?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_master_checklist_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_master_maintenance_schedules: {
        Row: {
          created_at: string
          description: string | null
          estimated_cost: number | null
          frequency: string
          id: string
          is_active: boolean
          month_day: number | null
          notes: string | null
          org_id: string
          specialty: string | null
          title: string
          updated_at: string
          week_day: number | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          frequency?: string
          id?: string
          is_active?: boolean
          month_day?: number | null
          notes?: string | null
          org_id: string
          specialty?: string | null
          title: string
          updated_at?: string
          week_day?: number | null
        }
        Update: {
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          frequency?: string
          id?: string
          is_active?: boolean
          month_day?: number | null
          notes?: string | null
          org_id?: string
          specialty?: string | null
          title?: string
          updated_at?: string
          week_day?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "org_master_maintenance_schedules_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_milestones: {
        Row: {
          achieved_at: string
          dismissed: boolean
          id: string
          milestone: string
          org_id: string
          prompted_at: string | null
          review_clicked: boolean
          value: Json | null
        }
        Insert: {
          achieved_at?: string
          dismissed?: boolean
          id?: string
          milestone: string
          org_id: string
          prompted_at?: string | null
          review_clicked?: boolean
          value?: Json | null
        }
        Update: {
          achieved_at?: string
          dismissed?: boolean
          id?: string
          milestone?: string
          org_id?: string
          prompted_at?: string | null
          review_clicked?: boolean
          value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "org_milestones_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          invite_accepted_at: string | null
          invite_token: string | null
          invited_email: string | null
          org_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          invite_accepted_at?: string | null
          invite_token?: string | null
          invited_email?: string | null
          org_id: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          invite_accepted_at?: string | null
          invite_token?: string | null
          invited_email?: string | null
          org_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          auto_assign_enabled: boolean
          auto_assign_mode: string
          billing_email: string | null
          comms_log_retention_days: number
          created_at: string
          id: string
          kroger_location_id: string | null
          kroger_location_name: string | null
          max_properties: number
          name: string
          onboarding_steps_completed: Json
          plan: Database["public"]["Enums"]["org_plan"]
          plan_status: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer: string | null
          repuguard_founding_member: boolean
          repuguard_status: string | null
          repuguard_stripe_subscription_id: string | null
          repuguard_trial_end: string | null
          repuguard_trial_start: string | null
          slack_webhook_url: string | null
          slug: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          auto_assign_enabled?: boolean
          auto_assign_mode?: string
          billing_email?: string | null
          comms_log_retention_days?: number
          created_at?: string
          id?: string
          kroger_location_id?: string | null
          kroger_location_name?: string | null
          max_properties?: number
          name: string
          onboarding_steps_completed?: Json
          plan?: Database["public"]["Enums"]["org_plan"]
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer?: string | null
          repuguard_founding_member?: boolean
          repuguard_status?: string | null
          repuguard_stripe_subscription_id?: string | null
          repuguard_trial_end?: string | null
          repuguard_trial_start?: string | null
          slack_webhook_url?: string | null
          slug: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          auto_assign_enabled?: boolean
          auto_assign_mode?: string
          billing_email?: string | null
          comms_log_retention_days?: number
          created_at?: string
          id?: string
          kroger_location_id?: string | null
          kroger_location_name?: string | null
          max_properties?: number
          name?: string
          onboarding_steps_completed?: Json
          plan?: Database["public"]["Enums"]["org_plan"]
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer?: string | null
          repuguard_founding_member?: boolean
          repuguard_status?: string | null
          repuguard_stripe_subscription_id?: string | null
          repuguard_trial_end?: string | null
          repuguard_trial_start?: string | null
          slack_webhook_url?: string | null
          slug?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      owner_portal_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          is_multi: boolean
          last_accessed_at: string | null
          property_ids: string[] | null
          property_owner_id: string
          revoked_at: string | null
          token: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_multi?: boolean
          last_accessed_at?: string | null
          property_ids?: string[] | null
          property_owner_id: string
          revoked_at?: string | null
          token?: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_multi?: boolean
          last_accessed_at?: string | null
          property_ids?: string[] | null
          property_owner_id?: string
          revoked_at?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_portal_tokens_property_owner_id_fkey"
            columns: ["property_owner_id"]
            isOneToOne: false
            referencedRelation: "property_owners"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_transactions: {
        Row: {
          amount: number
          booking_id: string | null
          category: Database["public"]["Enums"]["txn_category"]
          created_at: string
          description: string
          id: string
          notes: string | null
          org_id: string
          property_id: string
          purchase_order_id: string | null
          source: string | null
          source_reference_id: string | null
          transaction_date: string
          transaction_type: Database["public"]["Enums"]["txn_type"]
          updated_at: string
          visible_to_owner: boolean
          work_order_id: string | null
        }
        Insert: {
          amount: number
          booking_id?: string | null
          category?: Database["public"]["Enums"]["txn_category"]
          created_at?: string
          description: string
          id?: string
          notes?: string | null
          org_id: string
          property_id: string
          purchase_order_id?: string | null
          source?: string | null
          source_reference_id?: string | null
          transaction_date: string
          transaction_type: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
          visible_to_owner?: boolean
          work_order_id?: string | null
        }
        Update: {
          amount?: number
          booking_id?: string | null
          category?: Database["public"]["Enums"]["txn_category"]
          created_at?: string
          description?: string
          id?: string
          notes?: string | null
          org_id?: string
          property_id?: string
          purchase_order_id?: string | null
          source?: string | null
          source_reference_id?: string | null
          transaction_date?: string
          transaction_type?: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
          visible_to_owner?: boolean
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_transactions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_transactions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_transactions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_transactions_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_transactions_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      powersync_crew_instances: {
        Row: {
          instance_id: string
          user_id: string
        }
        Insert: {
          instance_id: string
          user_id: string
        }
        Update: {
          instance_id?: string
          user_id?: string
        }
        Relationships: []
      }
      powersync_crew_properties: {
        Row: {
          property_id: string
          user_id: string
        }
        Insert: {
          property_id: string
          user_id: string
        }
        Update: {
          property_id?: string
          user_id?: string
        }
        Relationships: []
      }
      powersync_crew_turnovers: {
        Row: {
          turnover_id: string
          user_id: string
        }
        Insert: {
          turnover_id: string
          user_id: string
        }
        Update: {
          turnover_id?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          access_instructions: string | null
          address: string | null
          avg_nightly_rate: number | null
          avg_stay_length: number | null
          avg_turnovers_per_month: number | null
          bathrooms: number | null
          bedrooms: number | null
          checkin_time: string | null
          checkout_time: string | null
          city: string | null
          cleaning_cost: number | null
          cleaning_cost_visible_to_owner: boolean
          created_at: string
          door_code: string | null
          external_id: string | null
          external_source: string | null
          id: string
          internal_notes: string | null
          is_active: boolean
          lat: number | null
          lng: number | null
          max_guests: number | null
          name: string
          org_id: string
          property_type: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct: number | null
          setup_steps_completed: Json
          square_footage: number | null
          state: string | null
          updated_at: string
          wifi_name: string | null
          wifi_password: string | null
          zip: string | null
        }
        Insert: {
          access_instructions?: string | null
          address?: string | null
          avg_nightly_rate?: number | null
          avg_stay_length?: number | null
          avg_turnovers_per_month?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          checkin_time?: string | null
          checkout_time?: string | null
          city?: string | null
          cleaning_cost?: number | null
          cleaning_cost_visible_to_owner?: boolean
          created_at?: string
          door_code?: string | null
          external_id?: string | null
          external_source?: string | null
          id?: string
          internal_notes?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          max_guests?: number | null
          name: string
          org_id: string
          property_type?: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct?: number | null
          setup_steps_completed?: Json
          square_footage?: number | null
          state?: string | null
          updated_at?: string
          wifi_name?: string | null
          wifi_password?: string | null
          zip?: string | null
        }
        Update: {
          access_instructions?: string | null
          address?: string | null
          avg_nightly_rate?: number | null
          avg_stay_length?: number | null
          avg_turnovers_per_month?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          checkin_time?: string | null
          checkout_time?: string | null
          city?: string | null
          cleaning_cost?: number | null
          cleaning_cost_visible_to_owner?: boolean
          created_at?: string
          door_code?: string | null
          external_id?: string | null
          external_source?: string | null
          id?: string
          internal_notes?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          max_guests?: number | null
          name?: string
          org_id?: string
          property_type?: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct?: number | null
          setup_steps_completed?: Json
          square_footage?: number | null
          state?: string | null
          updated_at?: string
          wifi_name?: string | null
          wifi_password?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "properties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      property_assets: {
        Row: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          created_at: string
          depreciation_method: string | null
          estimated_replacement_cost: number | null
          expected_lifespan_years: number | null
          health_score: number | null
          health_score_updated_at: string | null
          id: string
          installation_date: string | null
          is_active: boolean
          macrs_class: Database["public"]["Enums"]["macrs_class"] | null
          make: string | null
          manufacture_date: string | null
          model: string | null
          name: string
          notes: string | null
          org_id: string
          placed_in_service_date: string | null
          property_id: string
          purchase_price: number | null
          replaced_by_asset_id: string | null
          salvage_value: number | null
          serial_number: string | null
          updated_at: string
          warranty_expiry_date: string | null
          warranty_notes: string | null
          warranty_provider: string | null
        }
        Insert: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          depreciation_method?: string | null
          estimated_replacement_cost?: number | null
          expected_lifespan_years?: number | null
          health_score?: number | null
          health_score_updated_at?: string | null
          id?: string
          installation_date?: string | null
          is_active?: boolean
          macrs_class?: Database["public"]["Enums"]["macrs_class"] | null
          make?: string | null
          manufacture_date?: string | null
          model?: string | null
          name: string
          notes?: string | null
          org_id: string
          placed_in_service_date?: string | null
          property_id: string
          purchase_price?: number | null
          replaced_by_asset_id?: string | null
          salvage_value?: number | null
          serial_number?: string | null
          updated_at?: string
          warranty_expiry_date?: string | null
          warranty_notes?: string | null
          warranty_provider?: string | null
        }
        Update: {
          asset_type?: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          depreciation_method?: string | null
          estimated_replacement_cost?: number | null
          expected_lifespan_years?: number | null
          health_score?: number | null
          health_score_updated_at?: string | null
          id?: string
          installation_date?: string | null
          is_active?: boolean
          macrs_class?: Database["public"]["Enums"]["macrs_class"] | null
          make?: string | null
          manufacture_date?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          placed_in_service_date?: string | null
          property_id?: string
          purchase_price?: number | null
          replaced_by_asset_id?: string | null
          salvage_value?: number | null
          serial_number?: string | null
          updated_at?: string
          warranty_expiry_date?: string | null
          warranty_notes?: string | null
          warranty_provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_assets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_assets_replaced_by_asset_id_fkey"
            columns: ["replaced_by_asset_id"]
            isOneToOne: false
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      property_owners: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          property_id: string
          revenue_share_pct: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          property_id: string
          revenue_share_pct?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          property_id?: string
          revenue_share_pct?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_owners_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_owners_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_items: {
        Row: {
          created_at: string
          current_quantity: number
          estimated_unit_cost: number | null
          id: string
          inventory_item_id: string | null
          item_name: string
          notes: string | null
          par_level: number
          purchase_order_id: string
          quantity_to_buy: number
        }
        Insert: {
          created_at?: string
          current_quantity: number
          estimated_unit_cost?: number | null
          id?: string
          inventory_item_id?: string | null
          item_name: string
          notes?: string | null
          par_level: number
          purchase_order_id: string
          quantity_to_buy: number
        }
        Update: {
          created_at?: string
          current_quantity?: number
          estimated_unit_cost?: number | null
          id?: string
          inventory_item_id?: string | null
          item_name?: string
          notes?: string | null
          par_level?: number
          purchase_order_id?: string
          quantity_to_buy?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          acknowledged_at: string | null
          created_at: string
          generated_at: string
          id: string
          notes: string | null
          org_id: string
          property_id: string
          sent_at: string | null
          status: Database["public"]["Enums"]["po_status"]
          total_estimated_cost: number | null
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          generated_at?: string
          id?: string
          notes?: string | null
          org_id: string
          property_id: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          total_estimated_cost?: number | null
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          generated_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          property_id?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          total_estimated_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          crew_member_id: string
          endpoint: string
          id: string
          org_id: string
          p256dh: string
        }
        Insert: {
          auth: string
          created_at?: string
          crew_member_id: string
          endpoint: string
          id?: string
          org_id: string
          p256dh: string
        }
        Update: {
          auth?: string
          created_at?: string
          crew_member_id?: string
          endpoint?: string
          id?: string
          org_id?: string
          p256dh?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_requests: {
        Row: {
          created_at: string
          id: string
          org_id: string
          quote_notes: string | null
          quote_token: string
          quote_token_expires_at: string
          quoted_amount: number | null
          sent_at: string
          status: Database["public"]["Enums"]["quote_request_status"]
          submitted_at: string | null
          vendor_id: string
          work_order_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          quote_notes?: string | null
          quote_token: string
          quote_token_expires_at: string
          quoted_amount?: number | null
          sent_at?: string
          status?: Database["public"]["Enums"]["quote_request_status"]
          submitted_at?: string | null
          vendor_id: string
          work_order_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          quote_notes?: string | null
          quote_token?: string
          quote_token_expires_at?: string
          quoted_amount?: number | null
          sent_at?: string
          status?: Database["public"]["Enums"]["quote_request_status"]
          submitted_at?: string | null
          vendor_id?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_requests_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "quote_requests_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_requests_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      review_responses: {
        Row: {
          created_at: string
          edited_response: string | null
          flag_reason: string | null
          flags: string[]
          generated_at: string | null
          generated_response: string | null
          id: string
          org_id: string
          review_id: string
          tone_used: string | null
          updated_at: string
          word_count: number | null
        }
        Insert: {
          created_at?: string
          edited_response?: string | null
          flag_reason?: string | null
          flags?: string[]
          generated_at?: string | null
          generated_response?: string | null
          id?: string
          org_id: string
          review_id: string
          tone_used?: string | null
          updated_at?: string
          word_count?: number | null
        }
        Update: {
          created_at?: string
          edited_response?: string | null
          flag_reason?: string | null
          flags?: string[]
          generated_at?: string | null
          generated_response?: string | null
          id?: string
          org_id?: string
          review_id?: string
          tone_used?: string | null
          updated_at?: string
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "review_responses_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_responses_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          created_at: string
          external_id: string
          external_source: string
          external_url: string | null
          guest_name: string | null
          id: string
          org_id: string
          property_id: string | null
          rating: number
          response_status: string
          review_date: string | null
          review_text: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_id: string
          external_source?: string
          external_url?: string | null
          guest_name?: string | null
          id?: string
          org_id: string
          property_id?: string | null
          rating: number
          response_status?: string
          review_date?: string | null
          review_text: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_id?: string
          external_source?: string
          external_url?: string | null
          guest_name?: string | null
          id?: string
          org_id?: string
          property_id?: string | null
          rating?: number
          response_status?: string
          review_date?: string | null
          review_text?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_processed_events: {
        Row: {
          processed_at: string
          stripe_event_id: string
        }
        Insert: {
          processed_at?: string
          stripe_event_id: string
        }
        Update: {
          processed_at?: string
          stripe_event_id?: string
        }
        Relationships: []
      }
      turnover_assignments: {
        Row: {
          assigned_at: string
          created_at: string
          crew_member_id: string
          id: string
          notification_type: Database["public"]["Enums"]["contact_pref"] | null
          notified_at: string | null
          turnover_id: string
        }
        Insert: {
          assigned_at?: string
          created_at?: string
          crew_member_id: string
          id?: string
          notification_type?: Database["public"]["Enums"]["contact_pref"] | null
          notified_at?: string | null
          turnover_id: string
        }
        Update: {
          assigned_at?: string
          created_at?: string
          crew_member_id?: string
          id?: string
          notification_type?: Database["public"]["Enums"]["contact_pref"] | null
          notified_at?: string | null
          turnover_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "turnover_assignments_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnover_assignments_turnover_id_fkey"
            columns: ["turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
        ]
      }
      turnovers: {
        Row: {
          auto_generated: boolean
          booking_id: string | null
          checkin_datetime: string
          checklist_template_id: string | null
          checkout_datetime: string
          completed_at: string | null
          completion_notes: string | null
          created_at: string
          id: string
          is_same_day_turnover: boolean
          notes: string | null
          org_id: string
          prev_booking_id: string | null
          priority: Database["public"]["Enums"]["priority_level"]
          property_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["turnover_status"]
          suggested_crew_ids: string[] | null
          suggestion_reasoning: string | null
          suggestion_status: string | null
          updated_at: string
          window_minutes: number | null
        }
        Insert: {
          auto_generated?: boolean
          booking_id?: string | null
          checkin_datetime: string
          checklist_template_id?: string | null
          checkout_datetime: string
          completed_at?: string | null
          completion_notes?: string | null
          created_at?: string
          id?: string
          is_same_day_turnover?: boolean
          notes?: string | null
          org_id: string
          prev_booking_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["turnover_status"]
          suggested_crew_ids?: string[] | null
          suggestion_reasoning?: string | null
          suggestion_status?: string | null
          updated_at?: string
          window_minutes?: number | null
        }
        Update: {
          auto_generated?: boolean
          booking_id?: string | null
          checkin_datetime?: string
          checklist_template_id?: string | null
          checkout_datetime?: string
          completed_at?: string | null
          completion_notes?: string | null
          created_at?: string
          id?: string
          is_same_day_turnover?: boolean
          notes?: string | null
          org_id?: string
          prev_booking_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["turnover_status"]
          suggested_crew_ids?: string[] | null
          suggestion_reasoning?: string | null
          suggestion_status?: string | null
          updated_at?: string
          window_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "turnovers_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnovers_checklist_template_id_fkey"
            columns: ["checklist_template_id"]
            isOneToOne: false
            referencedRelation: "checklist_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnovers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnovers_prev_booking_id_fkey"
            columns: ["prev_booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnovers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_compliance_documents: {
        Row: {
          coverage_amount: number | null
          created_at: string
          document_name: string
          document_type: Database["public"]["Enums"]["compliance_doc_type"]
          document_url: string | null
          effective_date: string | null
          expiry_date: string | null
          first_warned_at: string | null
          hard_blocked_at: string | null
          id: string
          is_active: boolean
          is_verified: boolean
          issuer_name: string | null
          org_id: string
          policy_number: string | null
          updated_at: string
          vendor_id: string
          verification_notes: string | null
        }
        Insert: {
          coverage_amount?: number | null
          created_at?: string
          document_name: string
          document_type: Database["public"]["Enums"]["compliance_doc_type"]
          document_url?: string | null
          effective_date?: string | null
          expiry_date?: string | null
          first_warned_at?: string | null
          hard_blocked_at?: string | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          issuer_name?: string | null
          org_id: string
          policy_number?: string | null
          updated_at?: string
          vendor_id: string
          verification_notes?: string | null
        }
        Update: {
          coverage_amount?: number | null
          created_at?: string
          document_name?: string
          document_type?: Database["public"]["Enums"]["compliance_doc_type"]
          document_url?: string | null
          effective_date?: string | null
          expiry_date?: string | null
          first_warned_at?: string | null
          hard_blocked_at?: string | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          issuer_name?: string | null
          org_id?: string
          policy_number?: string | null
          updated_at?: string
          vendor_id?: string
          verification_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_compliance_documents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "vendor_compliance_documents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address: string | null
          avg_rating: number | null
          city: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          lat: number | null
          lng: number | null
          name: string
          notes: string | null
          org_id: string
          phone: string | null
          portal_enabled: boolean
          rating_count: number
          service_radius_miles: number | null
          service_zip: string | null
          specialty: Database["public"]["Enums"]["vendor_specialty"] | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          avg_rating?: number | null
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          notes?: string | null
          org_id: string
          phone?: string | null
          portal_enabled?: boolean
          rating_count?: number
          service_radius_miles?: number | null
          service_zip?: string | null
          specialty?: Database["public"]["Enums"]["vendor_specialty"] | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          avg_rating?: number | null
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          notes?: string | null
          org_id?: string
          phone?: string | null
          portal_enabled?: boolean
          rating_count?: number
          service_radius_miles?: number | null
          service_zip?: string | null
          specialty?: Database["public"]["Enums"]["vendor_specialty"] | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      wo_number_counters: {
        Row: {
          current_year: number
          last_number: number
          org_id: string
        }
        Insert: {
          current_year?: number
          last_number?: number
          org_id: string
        }
        Update: {
          current_year?: number
          last_number?: number
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wo_number_counters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_line_items: {
        Row: {
          created_at: string
          description: string
          id: string
          line_total: number | null
          line_type: Database["public"]["Enums"]["line_item_type"]
          org_id: string
          quantity: number
          sort_order: number
          unit: string | null
          unit_cost: number
          work_order_id: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          line_total?: number | null
          line_type?: Database["public"]["Enums"]["line_item_type"]
          org_id: string
          quantity?: number
          sort_order?: number
          unit?: string | null
          unit_cost: number
          work_order_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          line_total?: number | null
          line_type?: Database["public"]["Enums"]["line_item_type"]
          org_id?: string
          quantity?: number
          sort_order?: number
          unit?: string | null
          unit_cost?: number
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_line_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_line_items_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_photos: {
        Row: {
          created_at: string
          id: string
          storage_path: string
          uploaded_by: string | null
          work_order_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          storage_path: string
          uploaded_by?: string | null
          work_order_id: string
        }
        Update: {
          created_at?: string
          id?: string
          storage_path?: string
          uploaded_by?: string | null
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_photos_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_order_updates: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          org_id: string
          status_from: Database["public"]["Enums"]["wo_status"] | null
          status_to: Database["public"]["Enums"]["wo_status"] | null
          updated_by_user_id: string | null
          updated_via_vendor_portal: boolean
          work_order_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id: string
          status_from?: Database["public"]["Enums"]["wo_status"] | null
          status_to?: Database["public"]["Enums"]["wo_status"] | null
          updated_by_user_id?: string | null
          updated_via_vendor_portal?: boolean
          work_order_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          status_from?: Database["public"]["Enums"]["wo_status"] | null
          status_to?: Database["public"]["Enums"]["wo_status"] | null
          updated_by_user_id?: string | null
          updated_via_vendor_portal?: boolean
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_updates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_updates_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          access_notes: string | null
          actual_cost: number | null
          asset_id: string | null
          assigned_crew_id: string | null
          assigned_crew_member_id: string | null
          category: Database["public"]["Enums"]["wo_category"] | null
          completed_date: string | null
          completion_notes: string | null
          completion_token: string | null
          completion_token_expires_at: string | null
          completion_verified_at: string | null
          completion_verified_by: string | null
          created_at: string
          description: string | null
          estimated_cost: number | null
          id: string
          invoice_reference: string | null
          nte_amount: number | null
          org_id: string
          portal_enabled: boolean
          priority: Database["public"]["Enums"]["priority_level"]
          property_id: string
          scheduled_date: string | null
          source: Database["public"]["Enums"]["wo_source"]
          source_schedule_id: string | null
          source_turnover_id: string | null
          status: Database["public"]["Enums"]["wo_status"]
          title: string
          updated_at: string
          vendor_acknowledged_at: string | null
          vendor_acknowledged_by: string | null
          vendor_id: string | null
          vendor_rating: number | null
          vendor_rating_notes: string | null
          wo_number: string | null
        }
        Insert: {
          access_notes?: string | null
          actual_cost?: number | null
          asset_id?: string | null
          assigned_crew_id?: string | null
          assigned_crew_member_id?: string | null
          category?: Database["public"]["Enums"]["wo_category"] | null
          completed_date?: string | null
          completion_notes?: string | null
          completion_token?: string | null
          completion_token_expires_at?: string | null
          completion_verified_at?: string | null
          completion_verified_by?: string | null
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          id?: string
          invoice_reference?: string | null
          nte_amount?: number | null
          org_id: string
          portal_enabled?: boolean
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id: string
          scheduled_date?: string | null
          source?: Database["public"]["Enums"]["wo_source"]
          source_schedule_id?: string | null
          source_turnover_id?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          title: string
          updated_at?: string
          vendor_acknowledged_at?: string | null
          vendor_acknowledged_by?: string | null
          vendor_id?: string | null
          vendor_rating?: number | null
          vendor_rating_notes?: string | null
          wo_number?: string | null
        }
        Update: {
          access_notes?: string | null
          actual_cost?: number | null
          asset_id?: string | null
          assigned_crew_id?: string | null
          assigned_crew_member_id?: string | null
          category?: Database["public"]["Enums"]["wo_category"] | null
          completed_date?: string | null
          completion_notes?: string | null
          completion_token?: string | null
          completion_token_expires_at?: string | null
          completion_verified_at?: string | null
          completion_verified_by?: string | null
          created_at?: string
          description?: string | null
          estimated_cost?: number | null
          id?: string
          invoice_reference?: string | null
          nte_amount?: number | null
          org_id?: string
          portal_enabled?: boolean
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id?: string
          scheduled_date?: string | null
          source?: Database["public"]["Enums"]["wo_source"]
          source_schedule_id?: string | null
          source_turnover_id?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          title?: string
          updated_at?: string
          vendor_acknowledged_at?: string | null
          vendor_acknowledged_by?: string | null
          vendor_id?: string | null
          vendor_rating?: number | null
          vendor_rating_notes?: string | null
          wo_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_assigned_crew_id_fkey"
            columns: ["assigned_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_assigned_crew_member_id_fkey"
            columns: ["assigned_crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_source_turnover_id_fkey"
            columns: ["source_turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "work_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      vendor_compliance_status: {
        Row: {
          active_doc_count: number | null
          compliance_status: string | null
          days_past_expiry: number | null
          earliest_expired_date: string | null
          expired_doc_count: number | null
          expiring_soon_count: number | null
          lat: number | null
          lng: number | null
          org_id: string | null
          service_radius_miles: number | null
          service_zip: string | null
          vendor_id: string | null
          vendor_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      cleanup_expired_oauth_states: { Args: never; Returns: undefined }
      get_asset_repair_summary: {
        Args: never
        Returns: {
          asset_id: string
          last_serviced_at: string
          total_repair_cost: number
          total_repairs: number
        }[]
      }
      get_crew_member_id: { Args: never; Returns: string }
      get_repeat_issues: {
        Args: { since_date: string }
        Returns: {
          category: string
          org_id: string
          property_id: string
          wo_count: number
        }[]
      }
      get_user_org_ids: { Args: never; Returns: string[] }
      is_org_member: {
        Args: {
          p_org_id: string
          p_roles?: Database["public"]["Enums"]["member_role"][]
        }
        Returns: boolean
      }
      next_wo_number: { Args: { p_org_id: string }; Returns: string }
      read_integration_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: string
      }
      replace_master_checklist_items: {
        Args: { p_items: Json; p_org_id: string }
        Returns: undefined
      }
      revoke_integration_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: undefined
      }
      store_integration_token: {
        Args: {
          p_access_token: string
          p_external_user_id: string
          p_metadata?: Json
          p_provider_id: string
          p_scope?: string
          p_user_id: string
        }
        Returns: string
      }
    }
    Enums: {
      asset_type:
        | "hvac"
        | "water_heater"
        | "roof"
        | "refrigerator"
        | "washer"
        | "dryer"
        | "dishwasher"
        | "microwave"
        | "oven_range"
        | "pool_pump"
        | "hot_tub"
        | "garage_door"
        | "smart_lock"
        | "deck_structure"
        | "electrical_panel"
        | "plumbing_system"
        | "septic_system"
        | "well_pump"
        | "generator"
        | "solar_system"
        | "other"
      booking_source:
        | "airbnb"
        | "vrbo"
        | "booking_com"
        | "direct"
        | "manual"
        | "other"
      booking_status: "confirmed" | "cancelled" | "blocked" | "tentative"
      checklist_status: "not_started" | "in_progress" | "completed"
      comm_channel: "email" | "sms" | "phone" | "in_person" | "note"
      comm_recipient_type: "vendor" | "crew"
      comm_source: "manual" | "system"
      compliance_doc_type:
        | "coi"
        | "workers_comp"
        | "business_license"
        | "contractor_license"
        | "bonding"
        | "other"
      contact_pref: "email" | "sms" | "both"
      crew_role: "cleaning" | "landscaping" | "maintenance" | "general"
      ical_source: "airbnb" | "vrbo" | "booking_com" | "direct" | "other"
      inventory_category:
        | "paper_goods"
        | "cleaning"
        | "kitchen"
        | "bath"
        | "laundry"
        | "bedroom"
        | "outdoor"
        | "other"
        | "bedroom_linens"
        | "maintenance_safety"
        | "guest_experience"
        | "technology"
      line_item_type:
        | "labor"
        | "material"
        | "equipment"
        | "subcontractor"
        | "other"
      macrs_class:
        | "5_year"
        | "15_year"
        | "27_5_year"
        | "39_year"
        | "section_179"
      member_role: "admin" | "manager" | "crew" | "viewer" | "owner"
      message_status: "sent" | "failed" | "bounced"
      message_trigger: "booking_confirmed" | "pre_checkout"
      org_plan: "starter" | "growth" | "pro" | "enterprise"
      org_plan_status:
        | "trialing"
        | "active"
        | "past_due"
        | "cancelled"
        | "paused"
      po_status:
        | "draft"
        | "sent"
        | "acknowledged"
        | "ordered"
        | "received"
        | "cancelled"
      priority_level: "low" | "medium" | "high" | "urgent"
      property_type:
        | "house"
        | "condo"
        | "cabin"
        | "cottage"
        | "townhouse"
        | "other"
      quote_request_status:
        | "pending"
        | "submitted"
        | "approved"
        | "declined"
        | "expired"
      schedule_frequency:
        | "weekly"
        | "biweekly"
        | "monthly"
        | "quarterly"
        | "semi_annual"
        | "annual"
      schedule_type: "routine" | "seasonal"
      sync_status: "pending" | "success" | "error"
      turnover_status:
        | "pending_assignment"
        | "assigned"
        | "in_progress"
        | "completed"
        | "flagged"
        | "cancelled"
      txn_category:
        | "booking_revenue"
        | "cleaning_fee"
        | "maintenance"
        | "restock"
        | "utility"
        | "insurance"
        | "supplies"
        | "other"
      txn_type: "revenue" | "expense"
      vendor_specialty:
        | "plumbing"
        | "electrical"
        | "hvac"
        | "landscaping"
        | "cleaning"
        | "pest_control"
        | "pool"
        | "roofing"
        | "general"
        | "other"
      wo_category:
        | "hvac"
        | "plumbing"
        | "electrical"
        | "appliance"
        | "cleaning"
        | "landscaping"
        | "roofing"
        | "flooring"
        | "windows_doors"
        | "pest_control"
        | "pool"
        | "structural"
        | "general"
        | "other"
      wo_source:
        | "manual"
        | "maintenance_schedule"
        | "crew_flag"
        | "guest_report"
      wo_status:
        | "pending"
        | "quote_requested"
        | "assigned"
        | "in_progress"
        | "completed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      asset_type: [
        "hvac",
        "water_heater",
        "roof",
        "refrigerator",
        "washer",
        "dryer",
        "dishwasher",
        "microwave",
        "oven_range",
        "pool_pump",
        "hot_tub",
        "garage_door",
        "smart_lock",
        "deck_structure",
        "electrical_panel",
        "plumbing_system",
        "septic_system",
        "well_pump",
        "generator",
        "solar_system",
        "other",
      ],
      booking_source: [
        "airbnb",
        "vrbo",
        "booking_com",
        "direct",
        "manual",
        "other",
      ],
      booking_status: ["confirmed", "cancelled", "blocked", "tentative"],
      checklist_status: ["not_started", "in_progress", "completed"],
      comm_channel: ["email", "sms", "phone", "in_person", "note"],
      comm_recipient_type: ["vendor", "crew"],
      comm_source: ["manual", "system"],
      compliance_doc_type: [
        "coi",
        "workers_comp",
        "business_license",
        "contractor_license",
        "bonding",
        "other",
      ],
      contact_pref: ["email", "sms", "both"],
      crew_role: ["cleaning", "landscaping", "maintenance", "general"],
      ical_source: ["airbnb", "vrbo", "booking_com", "direct", "other"],
      inventory_category: [
        "paper_goods",
        "cleaning",
        "kitchen",
        "bath",
        "laundry",
        "bedroom",
        "outdoor",
        "other",
        "bedroom_linens",
        "maintenance_safety",
        "guest_experience",
        "technology",
      ],
      line_item_type: [
        "labor",
        "material",
        "equipment",
        "subcontractor",
        "other",
      ],
      macrs_class: ["5_year", "15_year", "27_5_year", "39_year", "section_179"],
      member_role: ["admin", "manager", "crew", "viewer", "owner"],
      message_status: ["sent", "failed", "bounced"],
      message_trigger: ["booking_confirmed", "pre_checkout"],
      org_plan: ["starter", "growth", "pro", "enterprise"],
      org_plan_status: [
        "trialing",
        "active",
        "past_due",
        "cancelled",
        "paused",
      ],
      po_status: [
        "draft",
        "sent",
        "acknowledged",
        "ordered",
        "received",
        "cancelled",
      ],
      priority_level: ["low", "medium", "high", "urgent"],
      property_type: [
        "house",
        "condo",
        "cabin",
        "cottage",
        "townhouse",
        "other",
      ],
      quote_request_status: [
        "pending",
        "submitted",
        "approved",
        "declined",
        "expired",
      ],
      schedule_frequency: [
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "semi_annual",
        "annual",
      ],
      schedule_type: ["routine", "seasonal"],
      sync_status: ["pending", "success", "error"],
      turnover_status: [
        "pending_assignment",
        "assigned",
        "in_progress",
        "completed",
        "flagged",
        "cancelled",
      ],
      txn_category: [
        "booking_revenue",
        "cleaning_fee",
        "maintenance",
        "restock",
        "utility",
        "insurance",
        "supplies",
        "other",
      ],
      txn_type: ["revenue", "expense"],
      vendor_specialty: [
        "plumbing",
        "electrical",
        "hvac",
        "landscaping",
        "cleaning",
        "pest_control",
        "pool",
        "roofing",
        "general",
        "other",
      ],
      wo_category: [
        "hvac",
        "plumbing",
        "electrical",
        "appliance",
        "cleaning",
        "landscaping",
        "roofing",
        "flooring",
        "windows_doors",
        "pest_control",
        "pool",
        "structural",
        "general",
        "other",
      ],
      wo_source: [
        "manual",
        "maintenance_schedule",
        "crew_flag",
        "guest_report",
      ],
      wo_status: [
        "pending",
        "quote_requested",
        "assigned",
        "in_progress",
        "completed",
        "cancelled",
      ],
    },
  },
} as const
