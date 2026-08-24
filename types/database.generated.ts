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
      asset_capex_recommendations: {
        Row: {
          asset_id: string
          computed_at: string
          created_at: string
          id: string
          notified_at: string | null
          org_id: string
          property_id: string
          reasoning: string[]
          recommendation: string
          remaining_book_value: number | null
          repair_cost_prior_12mo: number
          repair_cost_trailing_12mo: number
          repair_trend_pct: number | null
          replacement_cost_estimate: number
          updated_at: string
        }
        Insert: {
          asset_id: string
          computed_at: string
          created_at?: string
          id?: string
          notified_at?: string | null
          org_id: string
          property_id: string
          reasoning?: string[]
          recommendation: string
          remaining_book_value?: number | null
          repair_cost_prior_12mo?: number
          repair_cost_trailing_12mo?: number
          repair_trend_pct?: number | null
          replacement_cost_estimate: number
          updated_at?: string
        }
        Update: {
          asset_id?: string
          computed_at?: string
          created_at?: string
          id?: string
          notified_at?: string | null
          org_id?: string
          property_id?: string
          reasoning?: string[]
          recommendation?: string
          remaining_book_value?: number | null
          repair_cost_prior_12mo?: number
          repair_cost_trailing_12mo?: number
          repair_trend_pct?: number | null
          replacement_cost_estimate?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_capex_recommendations_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: true
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_capex_recommendations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_capex_recommendations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
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
          {
            foreignKeyName: "asset_depreciation_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_health_score_history: {
        Row: {
          age_score: number
          asset_id: string
          condition_score: number
          created_at: string
          health_score: number
          id: string
          org_id: string
          recorded_date: string
        }
        Insert: {
          age_score: number
          asset_id: string
          condition_score: number
          created_at?: string
          health_score: number
          id?: string
          org_id: string
          recorded_date: string
        }
        Update: {
          age_score?: number
          asset_id?: string
          condition_score?: number
          created_at?: string
          health_score?: number
          id?: string
          org_id?: string
          recorded_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_health_score_history_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_health_score_history_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_manuals: {
        Row: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          created_at: string
          found_via: string | null
          id: string
          make: string
          model: string
          org_id: string
          source_url: string | null
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          asset_type: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          found_via?: string | null
          id?: string
          make: string
          model: string
          org_id: string
          source_url?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          asset_type?: Database["public"]["Enums"]["asset_type"]
          created_at?: string
          found_via?: string | null
          id?: string
          make?: string
          model?: string
          org_id?: string
          source_url?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_manuals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_type_standards: {
        Row: {
          age_weight: number
          asset_type: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high: number | null
          avg_replacement_cost_low: number | null
          condition_weight: number
          display_name: string
          lifespan_max_years: number
          lifespan_min_years: number
          macrs_class_default: Database["public"]["Enums"]["macrs_class"]
          notes: string | null
          vendor_specialty_default:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
          weibull_shape: number | null
          weibull_shape_updated_at: string | null
          weight_updated_at: string | null
        }
        Insert: {
          age_weight?: number
          asset_type: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high?: number | null
          avg_replacement_cost_low?: number | null
          condition_weight?: number
          display_name: string
          lifespan_max_years: number
          lifespan_min_years: number
          macrs_class_default?: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          vendor_specialty_default?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
          weibull_shape?: number | null
          weibull_shape_updated_at?: string | null
          weight_updated_at?: string | null
        }
        Update: {
          age_weight?: number
          asset_type?: Database["public"]["Enums"]["asset_type"]
          avg_replacement_cost_high?: number | null
          avg_replacement_cost_low?: number | null
          condition_weight?: number
          display_name?: string
          lifespan_max_years?: number
          lifespan_min_years?: number
          macrs_class_default?: Database["public"]["Enums"]["macrs_class"]
          notes?: string | null
          vendor_specialty_default?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
          weibull_shape?: number | null
          weibull_shape_updated_at?: string | null
          weight_updated_at?: string | null
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
          scored_at: string | null
          started_at: string | null
          suggested_score: number | null
          turnover_id: string
          was_accepted: boolean | null
          was_late: boolean | null
          was_missed: boolean
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
          scored_at?: string | null
          started_at?: string | null
          suggested_score?: number | null
          turnover_id: string
          was_accepted?: boolean | null
          was_late?: boolean | null
          was_missed?: boolean
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
          scored_at?: string | null
          started_at?: string | null
          suggested_score?: number | null
          turnover_id?: string
          was_accepted?: boolean | null
          was_late?: boolean | null
          was_missed?: boolean
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
            foreignKeyName: "assignment_outcomes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          actual_total_amount: number | null
          checkin_date: string
          checkin_time: string | null
          checkout_date: string
          checkout_time: string | null
          created_at: string
          door_code_lock: string | null
          door_code_secret_id: string | null
          door_code_synced_at: string | null
          external_id: string | null
          external_source: string | null
          guest_email: string | null
          guest_name: string | null
          guest_pii_anonymized_at: string | null
          guidebook_pre_arrival_email_sent_at: string | null
          guidebook_token: string | null
          has_overlap_conflict: boolean
          ical_feed_id: string | null
          ical_uid: string | null
          id: string
          is_block: boolean
          notes: string | null
          org_id: string
          property_id: string
          raw_ical_data: Json | null
          source: Database["public"]["Enums"]["booking_source"] | null
          status: Database["public"]["Enums"]["booking_status"]
          stay_type: string
          updated_at: string
        }
        Insert: {
          actual_total_amount?: number | null
          checkin_date: string
          checkin_time?: string | null
          checkout_date: string
          checkout_time?: string | null
          created_at?: string
          door_code_lock?: string | null
          door_code_secret_id?: string | null
          door_code_synced_at?: string | null
          external_id?: string | null
          external_source?: string | null
          guest_email?: string | null
          guest_name?: string | null
          guest_pii_anonymized_at?: string | null
          guidebook_pre_arrival_email_sent_at?: string | null
          guidebook_token?: string | null
          has_overlap_conflict?: boolean
          ical_feed_id?: string | null
          ical_uid?: string | null
          id?: string
          is_block?: boolean
          notes?: string | null
          org_id: string
          property_id: string
          raw_ical_data?: Json | null
          source?: Database["public"]["Enums"]["booking_source"] | null
          status?: Database["public"]["Enums"]["booking_status"]
          stay_type?: string
          updated_at?: string
        }
        Update: {
          actual_total_amount?: number | null
          checkin_date?: string
          checkin_time?: string | null
          checkout_date?: string
          checkout_time?: string | null
          created_at?: string
          door_code_lock?: string | null
          door_code_secret_id?: string | null
          door_code_synced_at?: string | null
          external_id?: string | null
          external_source?: string | null
          guest_email?: string | null
          guest_name?: string | null
          guest_pii_anonymized_at?: string | null
          guidebook_pre_arrival_email_sent_at?: string | null
          guidebook_token?: string | null
          has_overlap_conflict?: boolean
          ical_feed_id?: string | null
          ical_uid?: string | null
          id?: string
          is_block?: boolean
          notes?: string | null
          org_id?: string
          property_id?: string
          raw_ical_data?: Json | null
          source?: Database["public"]["Enums"]["booking_source"] | null
          status?: Database["public"]["Enums"]["booking_status"]
          stay_type?: string
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
          asset_discovery_type: string | null
          completed_at: string | null
          completed_by_crew_id: string | null
          created_at: string
          crew_notes: string | null
          id: string
          instance_id: string
          is_completed: boolean
          is_mandatory: boolean
          is_section_final_item: boolean
          non_deletable: boolean
          notes: string | null
          photo_reason: string | null
          photo_storage_path: string | null
          requires_photo: boolean
          section_name: string
          sort_order: number
          task: string
          turnover_id: string | null
          updated_at: string
        }
        Insert: {
          asset_discovery_type?: string | null
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          crew_notes?: string | null
          id?: string
          instance_id: string
          is_completed?: boolean
          is_mandatory?: boolean
          is_section_final_item?: boolean
          non_deletable?: boolean
          notes?: string | null
          photo_reason?: string | null
          photo_storage_path?: string | null
          requires_photo?: boolean
          section_name: string
          sort_order?: number
          task: string
          turnover_id?: string | null
          updated_at?: string
        }
        Update: {
          asset_discovery_type?: string | null
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          crew_notes?: string | null
          id?: string
          instance_id?: string
          is_completed?: boolean
          is_mandatory?: boolean
          is_section_final_item?: boolean
          non_deletable?: boolean
          notes?: string | null
          photo_reason?: string | null
          photo_storage_path?: string | null
          requires_photo?: boolean
          section_name?: string
          sort_order?: number
          task?: string
          turnover_id?: string | null
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
          {
            foreignKeyName: "checklist_instance_items_turnover_id_fkey"
            columns: ["turnover_id"]
            isOneToOne: false
            referencedRelation: "turnovers"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_instances: {
        Row: {
          completed_at: string | null
          completed_by_crew_id: string | null
          created_at: string
          id: string
          org_id: string
          section_photo_path: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["checklist_status"]
          template_id: string | null
          template_snapshot: Json
          turnover_id: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          id?: string
          org_id: string
          section_photo_path?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["checklist_status"]
          template_id?: string | null
          template_snapshot: Json
          turnover_id: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_by_crew_id?: string | null
          created_at?: string
          id?: string
          org_id?: string
          section_photo_path?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["checklist_status"]
          template_id?: string | null
          template_snapshot?: Json
          turnover_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_instances_completed_by_crew_id_fkey"
            columns: ["completed_by_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
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
      checklist_item_signals: {
        Row: {
          alpha: number
          beta: number
          computed_at: string
          dynamic_photo_required: boolean | null
          flag_probability: number | null
          id: string
          org_id: string
          property_id: string
          reason: string | null
          section_name: string
          task: string
          total_completions: number
          total_flags: number
        }
        Insert: {
          alpha?: number
          beta?: number
          computed_at?: string
          dynamic_photo_required?: boolean | null
          flag_probability?: number | null
          id?: string
          org_id: string
          property_id: string
          reason?: string | null
          section_name: string
          task: string
          total_completions?: number
          total_flags?: number
        }
        Update: {
          alpha?: number
          beta?: number
          computed_at?: string
          dynamic_photo_required?: boolean | null
          flag_probability?: number | null
          id?: string
          org_id?: string
          property_id?: string
          reason?: string | null
          section_name?: string
          task?: string
          total_completions?: number
          total_flags?: number
        }
        Relationships: [
          {
            foreignKeyName: "checklist_item_signals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_item_signals_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
          room_synced_at: string | null
          room_template_id: string | null
          sort_order: number
          template_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          requires_section_photo?: boolean
          room_synced_at?: string | null
          room_template_id?: string | null
          sort_order?: number
          template_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          requires_section_photo?: boolean
          room_synced_at?: string | null
          room_template_id?: string | null
          sort_order?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_template_sections_room_template_id_fkey"
            columns: ["room_template_id"]
            isOneToOne: false
            referencedRelation: "room_templates"
            referencedColumns: ["id"]
          },
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
          dedup_key: string | null
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
          dedup_key?: string | null
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
          dedup_key?: string | null
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
          {
            foreignKeyName: "crew_availability_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_feedback: {
        Row: {
          crew_member_id: string
          feedback_text: string
          id: string
          org_id: string
          property_id: string | null
          submitted_at: string
        }
        Insert: {
          crew_member_id: string
          feedback_text: string
          id?: string
          org_id: string
          property_id?: string | null
          submitted_at?: string
        }
        Update: {
          crew_member_id?: string
          feedback_text?: string
          id?: string
          org_id?: string
          property_id?: string | null
          submitted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "crew_feedback_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crew_feedback_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crew_feedback_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      crew_members: {
        Row: {
          capacity_score: number
          created_at: string
          email: string | null
          external_id: string | null
          external_source: string | null
          home_lat: number | null
          home_lng: number | null
          home_zip: string | null
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
          external_id?: string | null
          external_source?: string | null
          home_lat?: number | null
          home_lng?: number | null
          home_zip?: string | null
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
          external_id?: string | null
          external_source?: string | null
          home_lat?: number | null
          home_lng?: number | null
          home_zip?: string | null
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
      demo_activity_log: {
        Row: {
          id: string
          kind: string
          org_id: string
          payload: Json
          simulated_at: string
        }
        Insert: {
          id?: string
          kind: string
          org_id: string
          payload?: Json
          simulated_at?: string
        }
        Update: {
          id?: string
          kind?: string
          org_id?: string
          payload?: Json
          simulated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "demo_activity_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      guidebook_configurations: {
        Row: {
          created_at: string
          extension_contact_method: string | null
          extension_discount_pct: number | null
          extension_gap_threshold_days: number
          extension_message_days_before: number
          extension_messaging_enabled: boolean
          extension_ownerrez_url: string | null
          grace_period_ends_at: string | null
          id: string
          is_active: boolean
          org_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          extension_contact_method?: string | null
          extension_discount_pct?: number | null
          extension_gap_threshold_days?: number
          extension_message_days_before?: number
          extension_messaging_enabled?: boolean
          extension_ownerrez_url?: string | null
          grace_period_ends_at?: string | null
          id?: string
          is_active?: boolean
          org_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          extension_contact_method?: string | null
          extension_discount_pct?: number | null
          extension_gap_threshold_days?: number
          extension_message_days_before?: number
          extension_messaging_enabled?: boolean
          extension_ownerrez_url?: string | null
          grace_period_ends_at?: string | null
          id?: string
          is_active?: boolean
          org_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guidebook_configurations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      guidebook_guest_sms_optins: {
        Row: {
          booking_id: string
          created_at: string
          door_code_sent_at: string | null
          id: string
          is_active: boolean
          last_evening_sms_date: string | null
          last_morning_sms_date: string | null
          opted_in_at: string
          opted_out_at: string | null
          org_id: string
          phone_e164: string
          property_id: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          door_code_sent_at?: string | null
          id?: string
          is_active?: boolean
          last_evening_sms_date?: string | null
          last_morning_sms_date?: string | null
          opted_in_at?: string
          opted_out_at?: string | null
          org_id: string
          phone_e164: string
          property_id: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          door_code_sent_at?: string | null
          id?: string
          is_active?: boolean
          last_evening_sms_date?: string | null
          last_morning_sms_date?: string | null
          opted_in_at?: string
          opted_out_at?: string | null
          org_id?: string
          phone_e164?: string
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guidebook_guest_sms_optins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guidebook_guest_sms_optins_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guidebook_guest_sms_optins_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      guidebook_offer_redemptions: {
        Row: {
          booking_id: string | null
          id: string
          open_count: number
          opened_at: string
          org_id: string
          sponsor_id: string
        }
        Insert: {
          booking_id?: string | null
          id?: string
          open_count?: number
          opened_at?: string
          org_id: string
          sponsor_id: string
        }
        Update: {
          booking_id?: string | null
          id?: string
          open_count?: number
          opened_at?: string
          org_id?: string
          sponsor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guidebook_offer_redemptions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guidebook_offer_redemptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guidebook_offer_redemptions_sponsor_id_fkey"
            columns: ["sponsor_id"]
            isOneToOne: false
            referencedRelation: "guidebook_sponsors"
            referencedColumns: ["id"]
          },
        ]
      }
      guidebook_property_configs: {
        Row: {
          check_in_instructions: string | null
          check_out_instructions: string | null
          created_at: string
          featured_amenities: string[] | null
          featured_amenity_notes: string | null
          hero_photo_storage_path: string | null
          house_rules: string | null
          id: string
          is_published: boolean
          org_id: string
          property_id: string
          slug: string
          updated_at: string
          wifi_network: string | null
          wifi_password: string | null
        }
        Insert: {
          check_in_instructions?: string | null
          check_out_instructions?: string | null
          created_at?: string
          featured_amenities?: string[] | null
          featured_amenity_notes?: string | null
          hero_photo_storage_path?: string | null
          house_rules?: string | null
          id?: string
          is_published?: boolean
          org_id: string
          property_id: string
          slug: string
          updated_at?: string
          wifi_network?: string | null
          wifi_password?: string | null
        }
        Update: {
          check_in_instructions?: string | null
          check_out_instructions?: string | null
          created_at?: string
          featured_amenities?: string[] | null
          featured_amenity_notes?: string | null
          hero_photo_storage_path?: string | null
          house_rules?: string | null
          id?: string
          is_published?: boolean
          org_id?: string
          property_id?: string
          slug?: string
          updated_at?: string
          wifi_network?: string | null
          wifi_password?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "guidebook_property_configs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guidebook_property_configs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      guidebook_sponsors: {
        Row: {
          activated_at: string | null
          address: string | null
          business_description: string | null
          business_name: string
          business_phone: string | null
          business_website: string | null
          checkout_session_id: string | null
          created_at: string
          custom_offer_text: string | null
          deactivated_at: string | null
          featured_item: string | null
          id: string
          lat: number | null
          lng: number | null
          media_kit_token: string
          offer_item: string | null
          offer_type: string
          offer_value: number | null
          org_id: string
          photo_storage_path: string | null
          slot_context: string | null
          slot_number: number
          slot_type: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          address?: string | null
          business_description?: string | null
          business_name: string
          business_phone?: string | null
          business_website?: string | null
          checkout_session_id?: string | null
          created_at?: string
          custom_offer_text?: string | null
          deactivated_at?: string | null
          featured_item?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          media_kit_token?: string
          offer_item?: string | null
          offer_type?: string
          offer_value?: number | null
          org_id: string
          photo_storage_path?: string | null
          slot_context?: string | null
          slot_number: number
          slot_type: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          address?: string | null
          business_description?: string | null
          business_name?: string
          business_phone?: string | null
          business_website?: string | null
          checkout_session_id?: string | null
          created_at?: string
          custom_offer_text?: string | null
          deactivated_at?: string | null
          featured_item?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          media_kit_token?: string
          offer_item?: string | null
          offer_type?: string
          offer_value?: number | null
          org_id?: string
          photo_storage_path?: string | null
          slot_context?: string | null
          slot_number?: number
          slot_type?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guidebook_sponsors_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      hospitable_launch_promo: {
        Row: {
          attribution_source: string | null
          awarded_at: string | null
          congrats_email_sent_at: string | null
          converted_to_paid_at: string | null
          created_at: string
          hospitable_tagged: boolean
          hospitable_tagged_at: string | null
          org_id: string
          price_lock_active: boolean
          price_lock_amount_cents: number | null
          price_lock_awarded: boolean
          price_lock_expires_at: string | null
          price_lock_sequence: number | null
          price_lock_tier: string | null
          price_lock_years: number | null
          updated_at: string
        }
        Insert: {
          attribution_source?: string | null
          awarded_at?: string | null
          congrats_email_sent_at?: string | null
          converted_to_paid_at?: string | null
          created_at?: string
          hospitable_tagged?: boolean
          hospitable_tagged_at?: string | null
          org_id: string
          price_lock_active?: boolean
          price_lock_amount_cents?: number | null
          price_lock_awarded?: boolean
          price_lock_expires_at?: string | null
          price_lock_sequence?: number | null
          price_lock_tier?: string | null
          price_lock_years?: number | null
          updated_at?: string
        }
        Update: {
          attribution_source?: string | null
          awarded_at?: string | null
          congrats_email_sent_at?: string | null
          converted_to_paid_at?: string | null
          created_at?: string
          hospitable_tagged?: boolean
          hospitable_tagged_at?: string | null
          org_id?: string
          price_lock_active?: boolean
          price_lock_amount_cents?: number | null
          price_lock_awarded?: boolean
          price_lock_expires_at?: string | null
          price_lock_sequence?: number | null
          price_lock_tier?: string | null
          price_lock_years?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hospitable_launch_promo_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
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
      inspection_form_items: {
        Row: {
          asks_property_fact: string | null
          asset_type: Database["public"]["Enums"]["asset_type"] | null
          concern_key: string | null
          created_at: string
          default_actions: Database["public"]["Enums"]["inspection_action"][]
          id: string
          is_required: boolean
          key: string
          na_asset_type: Database["public"]["Enums"]["asset_type"] | null
          na_reason_template: string | null
          parent_item_id: string | null
          per_unit: boolean
          photo_required: boolean
          po_catalog_item_id: string | null
          po_default_qty: number | null
          prompt: string
          remediation: Database["public"]["Enums"]["inspection_remediation"]
          repeat_per_asset: boolean
          repeat_source_item_id: string | null
          response_type: Database["public"]["Enums"]["inspection_response_type"]
          section_id: string
          show_when: Database["public"]["Enums"]["inspection_result"] | null
          shown_when_property_fact: string | null
          sort_order: number
          wo_category: Database["public"]["Enums"]["wo_category"] | null
          wo_priority: Database["public"]["Enums"]["priority_level"] | null
        }
        Insert: {
          asks_property_fact?: string | null
          asset_type?: Database["public"]["Enums"]["asset_type"] | null
          concern_key?: string | null
          created_at?: string
          default_actions?: Database["public"]["Enums"]["inspection_action"][]
          id?: string
          is_required?: boolean
          key: string
          na_asset_type?: Database["public"]["Enums"]["asset_type"] | null
          na_reason_template?: string | null
          parent_item_id?: string | null
          per_unit?: boolean
          photo_required?: boolean
          po_catalog_item_id?: string | null
          po_default_qty?: number | null
          prompt: string
          remediation?: Database["public"]["Enums"]["inspection_remediation"]
          repeat_per_asset?: boolean
          repeat_source_item_id?: string | null
          response_type?: Database["public"]["Enums"]["inspection_response_type"]
          section_id: string
          show_when?: Database["public"]["Enums"]["inspection_result"] | null
          shown_when_property_fact?: string | null
          sort_order?: number
          wo_category?: Database["public"]["Enums"]["wo_category"] | null
          wo_priority?: Database["public"]["Enums"]["priority_level"] | null
        }
        Update: {
          asks_property_fact?: string | null
          asset_type?: Database["public"]["Enums"]["asset_type"] | null
          concern_key?: string | null
          created_at?: string
          default_actions?: Database["public"]["Enums"]["inspection_action"][]
          id?: string
          is_required?: boolean
          key?: string
          na_asset_type?: Database["public"]["Enums"]["asset_type"] | null
          na_reason_template?: string | null
          parent_item_id?: string | null
          per_unit?: boolean
          photo_required?: boolean
          po_catalog_item_id?: string | null
          po_default_qty?: number | null
          prompt?: string
          remediation?: Database["public"]["Enums"]["inspection_remediation"]
          repeat_per_asset?: boolean
          repeat_source_item_id?: string | null
          response_type?: Database["public"]["Enums"]["inspection_response_type"]
          section_id?: string
          show_when?: Database["public"]["Enums"]["inspection_result"] | null
          shown_when_property_fact?: string | null
          sort_order?: number
          wo_category?: Database["public"]["Enums"]["wo_category"] | null
          wo_priority?: Database["public"]["Enums"]["priority_level"] | null
        }
        Relationships: [
          {
            foreignKeyName: "inspection_form_items_parent_item_id_fkey"
            columns: ["parent_item_id"]
            isOneToOne: false
            referencedRelation: "inspection_form_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_form_items_po_catalog_item_id_fkey"
            columns: ["po_catalog_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_form_items_repeat_source_item_id_fkey"
            columns: ["repeat_source_item_id"]
            isOneToOne: false
            referencedRelation: "inspection_form_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_form_items_section_id_fkey"
            columns: ["section_id"]
            isOneToOne: false
            referencedRelation: "inspection_form_sections"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_form_sections: {
        Row: {
          created_at: string
          form_id: string
          id: string
          key: string
          name: string
          shown_when_asset: Database["public"]["Enums"]["asset_type"] | null
          sort_order: number
        }
        Insert: {
          created_at?: string
          form_id: string
          id?: string
          key: string
          name: string
          shown_when_asset?: Database["public"]["Enums"]["asset_type"] | null
          sort_order?: number
        }
        Update: {
          created_at?: string
          form_id?: string
          id?: string
          key?: string
          name?: string
          shown_when_asset?: Database["public"]["Enums"]["asset_type"] | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "inspection_form_sections_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "inspection_forms"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_forms: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          key: string
          name: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key: string
          name: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key?: string
          name?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      inspection_items: {
        Row: {
          actions: Database["public"]["Enums"]["inspection_action"][]
          answered_at: string | null
          asset_id: string | null
          created_at: string
          form_item_id: string
          id: string
          inspection_id: string
          na_reason: string | null
          needs_cleaning: boolean
          note: string | null
          org_id: string
          photo_path: string | null
          photo_unavailable_reason: string | null
          prompt_snapshot: string
          repeat_answer:
            | Database["public"]["Enums"]["inspection_repeat_answer"]
            | null
          repeat_index: number | null
          repeat_of_work_order_id: string | null
          result: Database["public"]["Enums"]["inspection_result"] | null
          updated_at: string
          value_date: string | null
          value_number: number | null
          value_text: string | null
        }
        Insert: {
          actions?: Database["public"]["Enums"]["inspection_action"][]
          answered_at?: string | null
          asset_id?: string | null
          created_at?: string
          form_item_id: string
          id?: string
          inspection_id: string
          na_reason?: string | null
          needs_cleaning?: boolean
          note?: string | null
          org_id: string
          photo_path?: string | null
          photo_unavailable_reason?: string | null
          prompt_snapshot: string
          repeat_answer?:
            | Database["public"]["Enums"]["inspection_repeat_answer"]
            | null
          repeat_index?: number | null
          repeat_of_work_order_id?: string | null
          result?: Database["public"]["Enums"]["inspection_result"] | null
          updated_at?: string
          value_date?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Update: {
          actions?: Database["public"]["Enums"]["inspection_action"][]
          answered_at?: string | null
          asset_id?: string | null
          created_at?: string
          form_item_id?: string
          id?: string
          inspection_id?: string
          na_reason?: string | null
          needs_cleaning?: boolean
          note?: string | null
          org_id?: string
          photo_path?: string | null
          photo_unavailable_reason?: string | null
          prompt_snapshot?: string
          repeat_answer?:
            | Database["public"]["Enums"]["inspection_repeat_answer"]
            | null
          repeat_index?: number | null
          repeat_of_work_order_id?: string | null
          result?: Database["public"]["Enums"]["inspection_result"] | null
          updated_at?: string
          value_date?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inspection_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "property_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_items_form_item_id_fkey"
            columns: ["form_item_id"]
            isOneToOne: false
            referencedRelation: "inspection_form_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_items_inspection_id_fkey"
            columns: ["inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspection_items_repeat_of_work_order_id_fkey"
            columns: ["repeat_of_work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      inspections: {
        Row: {
          assigned_to_user_id: string | null
          completed_at: string | null
          completed_by_user_id: string | null
          corrects_inspection_id: string | null
          created_at: string
          device_clock_offset_seconds: number | null
          device_started_at: string | null
          form_id: string
          form_snapshot: Json
          form_version: number
          header_snapshot: Json | null
          id: string
          inspector_name: string | null
          org_id: string
          property_id: string
          scheduled_for: string | null
          source_schedule_id: string | null
          started_at: string
          started_at_source: string
          updated_at: string
        }
        Insert: {
          assigned_to_user_id?: string | null
          completed_at?: string | null
          completed_by_user_id?: string | null
          corrects_inspection_id?: string | null
          created_at?: string
          device_clock_offset_seconds?: number | null
          device_started_at?: string | null
          form_id: string
          form_snapshot: Json
          form_version: number
          header_snapshot?: Json | null
          id?: string
          inspector_name?: string | null
          org_id: string
          property_id: string
          scheduled_for?: string | null
          source_schedule_id?: string | null
          started_at?: string
          started_at_source?: string
          updated_at?: string
        }
        Update: {
          assigned_to_user_id?: string | null
          completed_at?: string | null
          completed_by_user_id?: string | null
          corrects_inspection_id?: string | null
          created_at?: string
          device_clock_offset_seconds?: number | null
          device_started_at?: string | null
          form_id?: string
          form_snapshot?: Json
          form_version?: number
          header_snapshot?: Json | null
          id?: string
          inspector_name?: string | null
          org_id?: string
          property_id?: string
          scheduled_for?: string | null
          source_schedule_id?: string | null
          started_at?: string
          started_at_source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspections_corrects_inspection_id_fkey"
            columns: ["corrects_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_form_id_fkey"
            columns: ["form_id"]
            isOneToOne: false
            referencedRelation: "inspection_forms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_source_schedule_id_fkey"
            columns: ["source_schedule_id"]
            isOneToOne: false
            referencedRelation: "maintenance_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_connections: {
        Row: {
          connected_at: string
          created_at: string
          expires_at: string | null
          external_user_id: string | null
          id: string
          last_used_at: string | null
          metadata: Json
          org_id: string | null
          provider_id: string
          reconnect_email_sent_at: string | null
          refresh_token_vault_secret_id: string | null
          scope: string | null
          status: string
          updated_at: string
          user_id: string
          vault_secret_id: string | null
          webhook_secret_hash: string | null
          webhook_token: string | null
        }
        Insert: {
          connected_at?: string
          created_at?: string
          expires_at?: string | null
          external_user_id?: string | null
          id?: string
          last_used_at?: string | null
          metadata?: Json
          org_id?: string | null
          provider_id: string
          reconnect_email_sent_at?: string | null
          refresh_token_vault_secret_id?: string | null
          scope?: string | null
          status?: string
          updated_at?: string
          user_id: string
          vault_secret_id?: string | null
          webhook_secret_hash?: string | null
          webhook_token?: string | null
        }
        Update: {
          connected_at?: string
          created_at?: string
          expires_at?: string | null
          external_user_id?: string | null
          id?: string
          last_used_at?: string | null
          metadata?: Json
          org_id?: string | null
          provider_id?: string
          reconnect_email_sent_at?: string | null
          refresh_token_vault_secret_id?: string | null
          scope?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          vault_secret_id?: string | null
          webhook_secret_hash?: string | null
          webhook_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integration_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_connections_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "integration_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_entity_owners: {
        Row: {
          created_at: string
          entity_kind: string
          external_id: string
          id: string
          org_id: string
          provider_id: string
          resolved_via: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_kind: string
          external_id: string
          id?: string
          org_id: string
          provider_id: string
          resolved_via: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_kind?: string
          external_id?: string
          id?: string
          org_id?: string
          provider_id?: string
          resolved_via?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_entity_owners_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          base_qty: number
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          default_par_level: number
          default_unit: string
          description: string | null
          id: string
          is_active: boolean
          is_consumable: boolean
          name: string
          par_mode: Database["public"]["Enums"]["par_mode"]
          smart_group: Database["public"]["Enums"]["par_smart_group"] | null
        }
        Insert: {
          base_qty?: number
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_par_level?: number
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          name: string
          par_mode?: Database["public"]["Enums"]["par_mode"]
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
        }
        Update: {
          base_qty?: number
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_par_level?: number
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          name?: string
          par_mode?: Database["public"]["Enums"]["par_mode"]
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
        }
        Relationships: []
      }
      inventory_consumption_stats: {
        Row: {
          avg_rate_per_guest_night: number
          inventory_item_id: string
          last_sample_at: string | null
          org_id: string
          sample_count: number
          updated_at: string
        }
        Insert: {
          avg_rate_per_guest_night?: number
          inventory_item_id: string
          last_sample_at?: string | null
          org_id: string
          sample_count?: number
          updated_at?: string
        }
        Update: {
          avg_rate_per_guest_night?: number
          inventory_item_id?: string
          last_sample_at?: string | null
          org_id?: string
          sample_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_consumption_stats_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: true
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_consumption_stats_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          auto_adjust: boolean
          base_qty: number
          catalog_item_id: string | null
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          current_quantity: number
          first_count_recorded_at: string | null
          id: string
          is_active: boolean
          is_consumable: boolean
          low_stock_threshold_pct: number
          name: string
          notes: string | null
          org_id: string
          par_level: number
          par_mode: Database["public"]["Enums"]["par_mode"]
          par_resolved_at: string | null
          preferred_brand: string | null
          property_id: string
          smart_group: Database["public"]["Enums"]["par_smart_group"] | null
          source_template_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          auto_adjust?: boolean
          base_qty?: number
          catalog_item_id?: string | null
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          current_quantity?: number
          first_count_recorded_at?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          low_stock_threshold_pct?: number
          name: string
          notes?: string | null
          org_id: string
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          par_resolved_at?: string | null
          preferred_brand?: string | null
          property_id: string
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          source_template_id?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          auto_adjust?: boolean
          base_qty?: number
          catalog_item_id?: string | null
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          current_quantity?: number
          first_count_recorded_at?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          low_stock_threshold_pct?: number
          name?: string
          notes?: string | null
          org_id?: string
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          par_resolved_at?: string | null
          preferred_brand?: string | null
          property_id?: string
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          source_template_id?: string | null
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
          {
            foreignKeyName: "inventory_items_source_template_id_fkey"
            columns: ["source_template_id"]
            isOneToOne: false
            referencedRelation: "inventory_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_template_items: {
        Row: {
          base_qty: number
          catalog_item_id: string | null
          category: string | null
          id: string
          name: string
          notes: string | null
          par_level: number
          par_mode: Database["public"]["Enums"]["par_mode"]
          par_qty: number
          preferred_brand: string | null
          smart_group: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order: number
          template_id: string
          unit: string | null
        }
        Insert: {
          base_qty?: number
          catalog_item_id?: string | null
          category?: string | null
          id?: string
          name: string
          notes?: string | null
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          par_qty?: number
          preferred_brand?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order?: number
          template_id: string
          unit?: string | null
        }
        Update: {
          base_qty?: number
          catalog_item_id?: string | null
          category?: string | null
          id?: string
          name?: string
          notes?: string | null
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          par_qty?: number
          preferred_brand?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order?: number
          template_id?: string
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_template_items_catalog_item_id_fkey"
            columns: ["catalog_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_catalog"
            referencedColumns: ["id"]
          },
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
          source_platform_template_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          org_id: string
          source_platform_template_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          org_id?: string
          source_platform_template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_templates_source_platform_template_id_fkey"
            columns: ["source_platform_template_id"]
            isOneToOne: false
            referencedRelation: "platform_inventory_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_catalog_items: {
        Row: {
          asset_category: string | null
          category: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          suggested_recurrence: string | null
        }
        Insert: {
          asset_category?: string | null
          category: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          suggested_recurrence?: string | null
        }
        Update: {
          asset_category?: string | null
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          suggested_recurrence?: string | null
        }
        Relationships: []
      }
      maintenance_completions: {
        Row: {
          asset_category: string | null
          completed_at: string
          completed_by: string | null
          created_at: string
          id: string
          maintenance_schedule_id: string
          next_due_date_set: string | null
          notes: string | null
          org_id: string
          property_id: string
          work_order_id: string | null
        }
        Insert: {
          asset_category?: string | null
          completed_at?: string
          completed_by?: string | null
          created_at?: string
          id?: string
          maintenance_schedule_id: string
          next_due_date_set?: string | null
          notes?: string | null
          org_id: string
          property_id: string
          work_order_id?: string | null
        }
        Update: {
          asset_category?: string | null
          completed_at?: string
          completed_by?: string | null
          created_at?: string
          id?: string
          maintenance_schedule_id?: string
          next_due_date_set?: string | null
          notes?: string | null
          org_id?: string
          property_id?: string
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_completions_maintenance_schedule_id_fkey"
            columns: ["maintenance_schedule_id"]
            isOneToOne: false
            referencedRelation: "maintenance_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_completions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_completions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_completions_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_schedule_template_items: {
        Row: {
          active_from_month: number | null
          active_to_month: number | null
          asset_category: string | null
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
          active_from_month?: number | null
          active_to_month?: number | null
          asset_category?: string | null
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
          active_from_month?: number | null
          active_to_month?: number | null
          asset_category?: string | null
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
          active_from_month: number | null
          active_to_month: number | null
          asset_category: string | null
          assigned_to_user_id: string | null
          assigned_vendor_id: string | null
          auto_create_wo: boolean
          created_at: string
          creates: Database["public"]["Enums"]["schedule_creates"]
          day_of_month_due: number | null
          description: string | null
          estimated_cost: number | null
          frequency: Database["public"]["Enums"]["schedule_frequency"] | null
          id: string
          inspection_form_id: string | null
          instructions: string | null
          is_active: boolean
          is_from_standard_template: boolean
          last_completed_date: string | null
          name: string
          next_due_date: string | null
          org_id: string
          property_id: string
          schedule_type: Database["public"]["Enums"]["schedule_type"]
          source_catalog_item_id: string | null
          source_template_item_id: string | null
          updated_at: string
          vendor_specialty_hint:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Insert: {
          active_from_month?: number | null
          active_to_month?: number | null
          asset_category?: string | null
          assigned_to_user_id?: string | null
          assigned_vendor_id?: string | null
          auto_create_wo?: boolean
          created_at?: string
          creates?: Database["public"]["Enums"]["schedule_creates"]
          day_of_month_due?: number | null
          description?: string | null
          estimated_cost?: number | null
          frequency?: Database["public"]["Enums"]["schedule_frequency"] | null
          id?: string
          inspection_form_id?: string | null
          instructions?: string | null
          is_active?: boolean
          is_from_standard_template?: boolean
          last_completed_date?: string | null
          name: string
          next_due_date?: string | null
          org_id: string
          property_id: string
          schedule_type?: Database["public"]["Enums"]["schedule_type"]
          source_catalog_item_id?: string | null
          source_template_item_id?: string | null
          updated_at?: string
          vendor_specialty_hint?:
            | Database["public"]["Enums"]["vendor_specialty"]
            | null
        }
        Update: {
          active_from_month?: number | null
          active_to_month?: number | null
          asset_category?: string | null
          assigned_to_user_id?: string | null
          assigned_vendor_id?: string | null
          auto_create_wo?: boolean
          created_at?: string
          creates?: Database["public"]["Enums"]["schedule_creates"]
          day_of_month_due?: number | null
          description?: string | null
          estimated_cost?: number | null
          frequency?: Database["public"]["Enums"]["schedule_frequency"] | null
          id?: string
          inspection_form_id?: string | null
          instructions?: string | null
          is_active?: boolean
          is_from_standard_template?: boolean
          last_completed_date?: string | null
          name?: string
          next_due_date?: string | null
          org_id?: string
          property_id?: string
          schedule_type?: Database["public"]["Enums"]["schedule_type"]
          source_catalog_item_id?: string | null
          source_template_item_id?: string | null
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
            foreignKeyName: "maintenance_schedules_inspection_form_id_fkey"
            columns: ["inspection_form_id"]
            isOneToOne: false
            referencedRelation: "inspection_forms"
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
          {
            foreignKeyName: "maintenance_schedules_source_catalog_item_id_fkey"
            columns: ["source_catalog_item_id"]
            isOneToOne: false
            referencedRelation: "org_maintenance_catalog_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_source_template_item_id_fkey"
            columns: ["source_template_item_id"]
            isOneToOne: false
            referencedRelation: "maintenance_schedule_template_items"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string
          group_id: string | null
          group_label: string | null
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
          group_id?: string | null
          group_label?: string | null
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
          group_id?: string | null
          group_label?: string | null
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
            foreignKeyName: "messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
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
      notification_digest_state: {
        Row: {
          category: string
          org_id: string
          snapshot: Json
          updated_at: string
        }
        Insert: {
          category: string
          org_id: string
          snapshot?: Json
          updated_at?: string
        }
        Update: {
          category?: string
          org_id?: string
          snapshot?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_digest_state_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          dedupe_key: string | null
          href: string
          id: string
          org_id: string
          read_at: string | null
          severity: string
          subtitle: string | null
          title: string
          type: string
        }
        Insert: {
          created_at?: string
          dedupe_key?: string | null
          href: string
          id?: string
          org_id: string
          read_at?: string | null
          severity?: string
          subtitle?: string | null
          title: string
          type: string
        }
        Update: {
          created_at?: string
          dedupe_key?: string | null
          href?: string
          id?: string
          org_id?: string
          read_at?: string | null
          severity?: string
          subtitle?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      org_inventory_catalog: {
        Row: {
          base_qty: number
          category: Database["public"]["Enums"]["inventory_category"]
          created_at: string
          default_par_level: number
          default_unit: string
          description: string | null
          id: string
          is_active: boolean
          is_consumable: boolean
          name: string
          org_id: string
          par_mode: Database["public"]["Enums"]["par_mode"]
          platform_catalog_item_id: string | null
          smart_group: Database["public"]["Enums"]["par_smart_group"] | null
          updated_at: string
        }
        Insert: {
          base_qty?: number
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_par_level?: number
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          name: string
          org_id: string
          par_mode?: Database["public"]["Enums"]["par_mode"]
          platform_catalog_item_id?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          updated_at?: string
        }
        Update: {
          base_qty?: number
          category?: Database["public"]["Enums"]["inventory_category"]
          created_at?: string
          default_par_level?: number
          default_unit?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_consumable?: boolean
          name?: string
          org_id?: string
          par_mode?: Database["public"]["Enums"]["par_mode"]
          platform_catalog_item_id?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_inventory_catalog_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_inventory_catalog_platform_catalog_item_id_fkey"
            columns: ["platform_catalog_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_catalog"
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
      org_maintenance_catalog_items: {
        Row: {
          asset_category: string | null
          category: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          org_id: string
          platform_catalog_item_id: string | null
          sort_order: number
          suggested_recurrence: string | null
          updated_at: string
        }
        Insert: {
          asset_category?: string | null
          category: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          org_id: string
          platform_catalog_item_id?: string | null
          sort_order?: number
          suggested_recurrence?: string | null
          updated_at?: string
        }
        Update: {
          asset_category?: string | null
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          org_id?: string
          platform_catalog_item_id?: string | null
          sort_order?: number
          suggested_recurrence?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_maintenance_catalog_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_maintenance_catalog_items_platform_catalog_item_id_fkey"
            columns: ["platform_catalog_item_id"]
            isOneToOne: false
            referencedRelation: "maintenance_catalog_items"
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
      org_sms_templates: {
        Row: {
          body: string
          created_at: string
          id: string
          key: string
          org_id: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          key: string
          org_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          key?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_sms_templates_org_id_fkey"
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
          bathroom_room_template_id: string | null
          bedroom_room_template_id: string | null
          billing_email: string | null
          capex_inflation_rate_pct: number
          comms_log_retention_days: number
          created_at: string
          default_room_templates_seeded_at: string | null
          guest_pii_retention_days: number
          id: string
          inspection_safety_frequency:
            | Database["public"]["Enums"]["schedule_frequency"]
            | null
          inspection_safety_start_month: number | null
          is_demo: boolean
          kroger_location_id: string | null
          kroger_location_name: string | null
          max_properties: number
          name: string
          onboarding_steps_completed: Json
          plan: Database["public"]["Enums"]["org_plan"]
          plan_status: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer: string | null
          slack_webhook_url: string | null
          slug: string
          stripe_customer_id: string | null
          stripe_event_at: string | null
          stripe_subscription_id: string | null
          trial_ends_at: string | null
          updated_at: string
          vendor_auto_assign_mode: string
        }
        Insert: {
          auto_assign_enabled?: boolean
          auto_assign_mode?: string
          bathroom_room_template_id?: string | null
          bedroom_room_template_id?: string | null
          billing_email?: string | null
          capex_inflation_rate_pct?: number
          comms_log_retention_days?: number
          created_at?: string
          default_room_templates_seeded_at?: string | null
          guest_pii_retention_days?: number
          id?: string
          inspection_safety_frequency?:
            | Database["public"]["Enums"]["schedule_frequency"]
            | null
          inspection_safety_start_month?: number | null
          is_demo?: boolean
          kroger_location_id?: string | null
          kroger_location_name?: string | null
          max_properties?: number
          name: string
          onboarding_steps_completed?: Json
          plan?: Database["public"]["Enums"]["org_plan"]
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer?: string | null
          slack_webhook_url?: string | null
          slug: string
          stripe_customer_id?: string | null
          stripe_event_at?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          vendor_auto_assign_mode?: string
        }
        Update: {
          auto_assign_enabled?: boolean
          auto_assign_mode?: string
          bathroom_room_template_id?: string | null
          bedroom_room_template_id?: string | null
          billing_email?: string | null
          capex_inflation_rate_pct?: number
          comms_log_retention_days?: number
          created_at?: string
          default_room_templates_seeded_at?: string | null
          guest_pii_retention_days?: number
          id?: string
          inspection_safety_frequency?:
            | Database["public"]["Enums"]["schedule_frequency"]
            | null
          inspection_safety_start_month?: number | null
          is_demo?: boolean
          kroger_location_id?: string | null
          kroger_location_name?: string | null
          max_properties?: number
          name?: string
          onboarding_steps_completed?: Json
          plan?: Database["public"]["Enums"]["org_plan"]
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          preferred_retailer?: string | null
          slack_webhook_url?: string | null
          slug?: string
          stripe_customer_id?: string | null
          stripe_event_at?: string | null
          stripe_subscription_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          vendor_auto_assign_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_bathroom_room_template_id_fkey"
            columns: ["bathroom_room_template_id"]
            isOneToOne: false
            referencedRelation: "room_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_bedroom_room_template_id_fkey"
            columns: ["bedroom_room_template_id"]
            isOneToOne: false
            referencedRelation: "room_templates"
            referencedColumns: ["id"]
          },
        ]
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
      pending_integration_links: {
        Row: {
          created_at: string
          expires_at: string
          external_user_id: string
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
          expires_at?: string
          external_user_id: string
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
          expires_at?: string
          external_user_id?: string
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
      pending_oauth_authorizations: {
        Row: {
          code_vault_secret_id: string
          created_at: string
          expires_at: string
          id: string
          pending_link_token: string
          provider_id: string
          redirect_uri: string
        }
        Insert: {
          code_vault_secret_id: string
          created_at?: string
          expires_at?: string
          id?: string
          pending_link_token: string
          provider_id: string
          redirect_uri: string
        }
        Update: {
          code_vault_secret_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          pending_link_token?: string
          provider_id?: string
          redirect_uri?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_oauth_authorizations_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "integration_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      platform_inventory_template_items: {
        Row: {
          base_qty: number
          catalog_item_id: string
          created_at: string
          id: string
          par_level: number
          par_mode: Database["public"]["Enums"]["par_mode"]
          platform_inventory_template_id: string
          preferred_brand: string | null
          smart_group: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order: number
        }
        Insert: {
          base_qty?: number
          catalog_item_id: string
          created_at?: string
          id?: string
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          platform_inventory_template_id: string
          preferred_brand?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order?: number
        }
        Update: {
          base_qty?: number
          catalog_item_id?: string
          created_at?: string
          id?: string
          par_level?: number
          par_mode?: Database["public"]["Enums"]["par_mode"]
          platform_inventory_template_id?: string
          preferred_brand?: string | null
          smart_group?: Database["public"]["Enums"]["par_smart_group"] | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "platform_inventory_template_i_platform_inventory_template__fkey"
            columns: ["platform_inventory_template_id"]
            isOneToOne: false
            referencedRelation: "platform_inventory_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_inventory_template_items_catalog_item_id_fkey"
            columns: ["catalog_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_inventory_templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_default: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_seed_room_template_items: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          platform_seed_room_template_id: string
          requires_photo: boolean
          sort_order: number
          task: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          platform_seed_room_template_id: string
          requires_photo?: boolean
          sort_order?: number
          task: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          platform_seed_room_template_id?: string
          requires_photo?: boolean
          sort_order?: number
          task?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_seed_room_template_i_platform_seed_room_template__fkey"
            columns: ["platform_seed_room_template_id"]
            isOneToOne: false
            referencedRelation: "platform_seed_room_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_seed_room_templates: {
        Row: {
          auto_include: boolean
          created_at: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          auto_include?: boolean
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          auto_include?: boolean
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_staff: {
        Row: {
          created_at: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      processed_webhooks: {
        Row: {
          processed_at: string
          webhook_id: string
        }
        Insert: {
          processed_at?: string
          webhook_id: string
        }
        Update: {
          processed_at?: string
          webhook_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email_unsubscribed_at: string | null
          full_name: string | null
          id: string
          phone: string | null
          unsubscribe_token: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email_unsubscribed_at?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          unsubscribe_token?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email_unsubscribed_at?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          unsubscribe_token?: string
          updated_at?: string
        }
        Relationships: []
      }
      promo_hospitable_launch_counter: {
        Row: {
          first_tier_awarded_count: number
          first_tier_max: number
          id: number
          launch_at: string
          second_tier_awarded_count: number
          second_tier_max: number
          second_tier_window_days: number
        }
        Insert: {
          first_tier_awarded_count?: number
          first_tier_max?: number
          id?: number
          launch_at?: string
          second_tier_awarded_count?: number
          second_tier_max?: number
          second_tier_window_days?: number
        }
        Update: {
          first_tier_awarded_count?: number
          first_tier_max?: number
          id?: number
          launch_at?: string
          second_tier_awarded_count?: number
          second_tier_max?: number
          second_tier_window_days?: number
        }
        Relationships: []
      }
      properties: {
        Row: {
          access_instructions: string | null
          address: string | null
          amenities: Json | null
          avg_nightly_rate: number | null
          avg_stay_length: number | null
          avg_turnovers_per_month: number | null
          bathrooms: number | null
          bedrooms: number | null
          checkin_time: string | null
          checkout_instructions: string | null
          checkout_time: string | null
          city: string | null
          cleaning_cost: number | null
          cleaning_cost_visible_to_owner: boolean
          created_at: string
          door_code_secret_id: string | null
          events_allowed: boolean | null
          external_id: string | null
          external_missing_since: string | null
          external_source: string | null
          has_security_system: boolean | null
          house_manual: string | null
          id: string
          internal_notes: string | null
          is_active: boolean
          lat: number | null
          lng: number | null
          max_guests: number | null
          max_pets: number | null
          min_renter_age: number | null
          name: string
          org_id: string
          pets_allowed: boolean | null
          property_type: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct: number | null
          setup_steps_completed: Json
          smoking_allowed: boolean | null
          square_footage: number | null
          state: string | null
          timezone: string
          updated_at: string
          wifi_name: string | null
          wifi_password: string | null
          zip: string | null
        }
        Insert: {
          access_instructions?: string | null
          address?: string | null
          amenities?: Json | null
          avg_nightly_rate?: number | null
          avg_stay_length?: number | null
          avg_turnovers_per_month?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          checkin_time?: string | null
          checkout_instructions?: string | null
          checkout_time?: string | null
          city?: string | null
          cleaning_cost?: number | null
          cleaning_cost_visible_to_owner?: boolean
          created_at?: string
          door_code_secret_id?: string | null
          events_allowed?: boolean | null
          external_id?: string | null
          external_missing_since?: string | null
          external_source?: string | null
          has_security_system?: boolean | null
          house_manual?: string | null
          id?: string
          internal_notes?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          max_guests?: number | null
          max_pets?: number | null
          min_renter_age?: number | null
          name: string
          org_id: string
          pets_allowed?: boolean | null
          property_type?: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct?: number | null
          setup_steps_completed?: Json
          smoking_allowed?: boolean | null
          square_footage?: number | null
          state?: string | null
          timezone?: string
          updated_at?: string
          wifi_name?: string | null
          wifi_password?: string | null
          zip?: string | null
        }
        Update: {
          access_instructions?: string | null
          address?: string | null
          amenities?: Json | null
          avg_nightly_rate?: number | null
          avg_stay_length?: number | null
          avg_turnovers_per_month?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          checkin_time?: string | null
          checkout_instructions?: string | null
          checkout_time?: string | null
          city?: string | null
          cleaning_cost?: number | null
          cleaning_cost_visible_to_owner?: boolean
          created_at?: string
          door_code_secret_id?: string | null
          events_allowed?: boolean | null
          external_id?: string | null
          external_missing_since?: string | null
          external_source?: string | null
          has_security_system?: boolean | null
          house_manual?: string | null
          id?: string
          internal_notes?: string | null
          is_active?: boolean
          lat?: number | null
          lng?: number | null
          max_guests?: number | null
          max_pets?: number | null
          min_renter_age?: number | null
          name?: string
          org_id?: string
          pets_allowed?: boolean | null
          property_type?: Database["public"]["Enums"]["property_type"] | null
          same_day_premium_pct?: number | null
          setup_steps_completed?: Json
          smoking_allowed?: boolean | null
          square_footage?: number | null
          state?: string | null
          timezone?: string
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
          is_na: boolean
          macrs_class: Database["public"]["Enums"]["macrs_class"] | null
          make: string | null
          manufacture_date: string | null
          model: string | null
          name: string
          notes: string | null
          org_id: string
          photo_url: string | null
          placed_in_service_date: string | null
          property_id: string
          purchase_price: number | null
          replaced_at: string | null
          replaced_by_asset_id: string | null
          replacement_status: string
          salvage_value: number | null
          scan_status: Database["public"]["Enums"]["asset_scan_status"] | null
          serial_number: string | null
          updated_at: string
          verified_at: string | null
          warranty_expiry_date: string | null
          warranty_notes: string | null
          warranty_provider: string | null
          warranty_warned_at: string | null
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
          is_na?: boolean
          macrs_class?: Database["public"]["Enums"]["macrs_class"] | null
          make?: string | null
          manufacture_date?: string | null
          model?: string | null
          name: string
          notes?: string | null
          org_id: string
          photo_url?: string | null
          placed_in_service_date?: string | null
          property_id: string
          purchase_price?: number | null
          replaced_at?: string | null
          replaced_by_asset_id?: string | null
          replacement_status?: string
          salvage_value?: number | null
          scan_status?: Database["public"]["Enums"]["asset_scan_status"] | null
          serial_number?: string | null
          updated_at?: string
          verified_at?: string | null
          warranty_expiry_date?: string | null
          warranty_notes?: string | null
          warranty_provider?: string | null
          warranty_warned_at?: string | null
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
          is_na?: boolean
          macrs_class?: Database["public"]["Enums"]["macrs_class"] | null
          make?: string | null
          manufacture_date?: string | null
          model?: string | null
          name?: string
          notes?: string | null
          org_id?: string
          photo_url?: string | null
          placed_in_service_date?: string | null
          property_id?: string
          purchase_price?: number | null
          replaced_at?: string | null
          replaced_by_asset_id?: string | null
          replacement_status?: string
          salvage_value?: number | null
          scan_status?: Database["public"]["Enums"]["asset_scan_status"] | null
          serial_number?: string | null
          updated_at?: string
          verified_at?: string | null
          warranty_expiry_date?: string | null
          warranty_notes?: string | null
          warranty_provider?: string | null
          warranty_warned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_assets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
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
          share_capital_plan: boolean
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
          share_capital_plan?: boolean
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
          share_capital_plan?: boolean
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
          unit: string | null
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
          unit?: string | null
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
          unit?: string | null
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
          is_same_day_flip: boolean
          notes: string | null
          order_email_sent: boolean
          org_id: string
          property_id: string
          sent_at: string | null
          source_count_id: string | null
          source_inspection_id: string | null
          status: Database["public"]["Enums"]["po_status"]
          total_estimated_cost: number | null
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          generated_at?: string
          id?: string
          is_same_day_flip?: boolean
          notes?: string | null
          order_email_sent?: boolean
          org_id: string
          property_id: string
          sent_at?: string | null
          source_count_id?: string | null
          source_inspection_id?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          total_estimated_cost?: number | null
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          generated_at?: string
          id?: string
          is_same_day_flip?: boolean
          notes?: string | null
          order_email_sent?: boolean
          org_id?: string
          property_id?: string
          sent_at?: string | null
          source_count_id?: string | null
          source_inspection_id?: string | null
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
          {
            foreignKeyName: "purchase_orders_source_count_id_fkey"
            columns: ["source_count_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_source_inspection_id_fkey"
            columns: ["source_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          crew_member_id: string | null
          endpoint: string
          id: string
          org_id: string
          p256dh: string
          user_id: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          crew_member_id?: string | null
          endpoint: string
          id?: string
          org_id: string
          p256dh: string
          user_id?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          crew_member_id?: string | null
          endpoint?: string
          id?: string
          org_id?: string
          p256dh?: string
          user_id?: string | null
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
      quote_request_line_items: {
        Row: {
          created_at: string
          description: string
          id: string
          line_total: number | null
          line_type: Database["public"]["Enums"]["line_item_type"]
          org_id: string
          quantity: number
          quote_request_id: string
          sort_order: number
          unit: string | null
          unit_cost: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          line_total?: number | null
          line_type?: Database["public"]["Enums"]["line_item_type"]
          org_id: string
          quantity?: number
          quote_request_id: string
          sort_order?: number
          unit?: string | null
          unit_cost: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          line_total?: number | null
          line_type?: Database["public"]["Enums"]["line_item_type"]
          org_id?: string
          quantity?: number
          quote_request_id?: string
          sort_order?: number
          unit?: string | null
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_request_line_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_request_line_items_quote_request_id_fkey"
            columns: ["quote_request_id"]
            isOneToOne: false
            referencedRelation: "quote_requests"
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
      reservation_messages: {
        Row: {
          attachments: Json | null
          body: string | null
          booking_id: string | null
          content_type: string | null
          conversation_id: string | null
          created_at: string
          dedup_key: string
          external_reservation_id: string | null
          external_source: string
          id: string
          message_created_at: string
          org_id: string
          platform: string | null
          sender_name: string | null
          sender_type: string
          source: string | null
        }
        Insert: {
          attachments?: Json | null
          body?: string | null
          booking_id?: string | null
          content_type?: string | null
          conversation_id?: string | null
          created_at?: string
          dedup_key: string
          external_reservation_id?: string | null
          external_source?: string
          id?: string
          message_created_at: string
          org_id: string
          platform?: string | null
          sender_name?: string | null
          sender_type: string
          source?: string | null
        }
        Update: {
          attachments?: Json | null
          body?: string | null
          booking_id?: string | null
          content_type?: string | null
          conversation_id?: string | null
          created_at?: string
          dedup_key?: string
          external_reservation_id?: string | null
          external_source?: string
          id?: string
          message_created_at?: string
          org_id?: string
          platform?: string | null
          sender_name?: string | null
          sender_type?: string
          source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reservation_messages_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_messages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          regeneration_count: number
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
          regeneration_count?: number
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
          regeneration_count?: number
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
      room_template_items: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          requires_photo: boolean
          room_template_id: string
          sort_order: number
          task: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          requires_photo?: boolean
          room_template_id: string
          sort_order?: number
          task: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          requires_photo?: boolean
          room_template_id?: string
          sort_order?: number
          task?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_template_items_room_template_id_fkey"
            columns: ["room_template_id"]
            isOneToOne: false
            referencedRelation: "room_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      room_templates: {
        Row: {
          auto_include: boolean
          created_at: string
          id: string
          is_system: boolean
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          auto_include?: boolean
          created_at?: string
          id?: string
          is_system?: boolean
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          auto_include?: boolean
          created_at?: string
          id?: string
          is_system?: boolean
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      stay_extension_requests: {
        Row: {
          booking_id: string
          created_at: string
          discount_pct: number | null
          gap_days: number
          id: string
          next_booking_checkin: string | null
          org_id: string
          pm_notified_at: string | null
          property_id: string
          sms_sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          discount_pct?: number | null
          gap_days: number
          id?: string
          next_booking_checkin?: string | null
          org_id: string
          pm_notified_at?: string | null
          property_id: string
          sms_sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          discount_pct?: number | null
          gap_days?: number
          id?: string
          next_booking_checkin?: string | null
          org_id?: string
          pm_notified_at?: string | null
          property_id?: string
          sms_sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stay_extension_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stay_extension_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stay_extension_requests_property_id_fkey"
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
      support_conversations: {
        Row: {
          assigned_staff_id: string | null
          created_at: string
          escalated_at: string | null
          escalation_reason: string | null
          id: string
          last_message_at: string
          needs_human: boolean
          org_id: string
          resolved_at: string | null
          staff_notified_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          assigned_staff_id?: string | null
          created_at?: string
          escalated_at?: string | null
          escalation_reason?: string | null
          id?: string
          last_message_at?: string
          needs_human?: boolean
          org_id: string
          resolved_at?: string | null
          staff_notified_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          assigned_staff_id?: string | null
          created_at?: string
          escalated_at?: string | null
          escalation_reason?: string | null
          id?: string
          last_message_at?: string
          needs_human?: boolean
          org_id?: string
          resolved_at?: string | null
          staff_notified_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      support_kb_chunks: {
        Row: {
          content: string
          created_at: string
          embedding: string | null
          id: string
          source: string | null
          title: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          embedding?: string | null
          id?: string
          source?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          embedding?: string | null
          id?: string
          source?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      support_messages: {
        Row: {
          category: Database["public"]["Enums"]["support_category"] | null
          content: string
          conversation_id: string
          created_at: string
          id: string
          model_used: string | null
          role: Database["public"]["Enums"]["support_message_role"]
          sent_by_user_id: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["support_category"] | null
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          model_used?: string | null
          role: Database["public"]["Enums"]["support_message_role"]
          sent_by_user_id?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["support_category"] | null
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          model_used?: string | null
          role?: Database["public"]["Enums"]["support_message_role"]
          sent_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "support_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      system_job_runs: {
        Row: {
          attempt: number
          created_at: string
          duration_ms: number | null
          error_message: string | null
          error_stack: string | null
          finished_at: string | null
          function_id: string
          function_name: string
          id: string
          metadata: Json
          org_id: string | null
          run_id: string
          started_at: string
          status: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          error_stack?: string | null
          finished_at?: string | null
          function_id: string
          function_name: string
          id?: string
          metadata?: Json
          org_id?: string | null
          run_id: string
          started_at?: string
          status?: string
        }
        Update: {
          attempt?: number
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          error_stack?: string | null
          finished_at?: string | null
          function_id?: string
          function_name?: string
          id?: string
          metadata?: Json
          org_id?: string | null
          run_id?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "system_job_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      turnover_assignments: {
        Row: {
          assigned_at: string
          created_at: string
          crew_member_id: string
          id: string
          notification_type: Database["public"]["Enums"]["contact_pref"] | null
          notified_at: string | null
          org_id: string | null
          property_id: string | null
          turnover_id: string
          user_id: string | null
        }
        Insert: {
          assigned_at?: string
          created_at?: string
          crew_member_id: string
          id?: string
          notification_type?: Database["public"]["Enums"]["contact_pref"] | null
          notified_at?: string | null
          org_id?: string | null
          property_id?: string | null
          turnover_id: string
          user_id?: string | null
        }
        Update: {
          assigned_at?: string
          created_at?: string
          crew_member_id?: string
          id?: string
          notification_type?: Database["public"]["Enums"]["contact_pref"] | null
          notified_at?: string | null
          org_id?: string | null
          property_id?: string | null
          turnover_id?: string
          user_id?: string | null
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
            foreignKeyName: "turnover_assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "turnover_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
          crew_duration_minutes: number | null
          dates_change_acknowledged_at: string | null
          dates_changed_at: string | null
          id: string
          inventory_confirmed_by_crew_id: string | null
          inventory_confirmed_complete_at: string | null
          inventory_started_at: string | null
          is_archived: boolean
          is_same_day_turnover: boolean
          notes: string | null
          org_id: string
          pending_checkin_datetime: string | null
          pending_checkout_datetime: string | null
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
          crew_duration_minutes?: number | null
          dates_change_acknowledged_at?: string | null
          dates_changed_at?: string | null
          id?: string
          inventory_confirmed_by_crew_id?: string | null
          inventory_confirmed_complete_at?: string | null
          inventory_started_at?: string | null
          is_archived?: boolean
          is_same_day_turnover?: boolean
          notes?: string | null
          org_id: string
          pending_checkin_datetime?: string | null
          pending_checkout_datetime?: string | null
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
          crew_duration_minutes?: number | null
          dates_change_acknowledged_at?: string | null
          dates_changed_at?: string | null
          id?: string
          inventory_confirmed_by_crew_id?: string | null
          inventory_confirmed_complete_at?: string | null
          inventory_started_at?: string | null
          is_archived?: boolean
          is_same_day_turnover?: boolean
          notes?: string | null
          org_id?: string
          pending_checkin_datetime?: string | null
          pending_checkout_datetime?: string | null
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
            foreignKeyName: "turnovers_inventory_confirmed_by_crew_id_fkey"
            columns: ["inventory_confirmed_by_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
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
      vendor_assignment_outcomes: {
        Row: {
          created_at: string
          id: string
          org_id: string
          override_reason: string | null
          property_id: string | null
          score_breakdown: Json | null
          suggested_score: number | null
          vendor_id: string
          was_accepted: boolean | null
          was_suggestion: boolean
          work_order_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          override_reason?: string | null
          property_id?: string | null
          score_breakdown?: Json | null
          suggested_score?: number | null
          vendor_id: string
          was_accepted?: boolean | null
          was_suggestion?: boolean
          work_order_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          override_reason?: string | null
          property_id?: string | null
          score_breakdown?: Json | null
          suggested_score?: number | null
          vendor_id?: string
          was_accepted?: boolean | null
          was_suggestion?: boolean
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_assignment_outcomes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_assignment_outcomes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_assignment_outcomes_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "vendor_assignment_outcomes_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_assignment_outcomes_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
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
            foreignKeyName: "vendor_compliance_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
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
          on_time_pct: number | null
          on_time_sample_size: number
          org_id: string
          phone: string | null
          portal_enabled: boolean
          rating_count: number
          service_radius_miles: number | null
          service_zip: string | null
          specialty: Database["public"]["Enums"]["vendor_specialty"] | null
          state: string | null
          stripe_connect_account_id: string | null
          stripe_connect_account_pending_at: string | null
          stripe_connect_charges_enabled: boolean
          stripe_connect_invite_claimed_at: string | null
          stripe_connect_invite_delivery_ref: string | null
          stripe_connect_invite_sent_at: string | null
          stripe_connect_onboarded_at: string | null
          stripe_connect_token: string
          stripe_connect_token_expires_at: string | null
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
          on_time_pct?: number | null
          on_time_sample_size?: number
          org_id: string
          phone?: string | null
          portal_enabled?: boolean
          rating_count?: number
          service_radius_miles?: number | null
          service_zip?: string | null
          specialty?: Database["public"]["Enums"]["vendor_specialty"] | null
          state?: string | null
          stripe_connect_account_id?: string | null
          stripe_connect_account_pending_at?: string | null
          stripe_connect_charges_enabled?: boolean
          stripe_connect_invite_claimed_at?: string | null
          stripe_connect_invite_delivery_ref?: string | null
          stripe_connect_invite_sent_at?: string | null
          stripe_connect_onboarded_at?: string | null
          stripe_connect_token?: string
          stripe_connect_token_expires_at?: string | null
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
          on_time_pct?: number | null
          on_time_sample_size?: number
          org_id?: string
          phone?: string | null
          portal_enabled?: boolean
          rating_count?: number
          service_radius_miles?: number | null
          service_zip?: string | null
          specialty?: Database["public"]["Enums"]["vendor_specialty"] | null
          state?: string | null
          stripe_connect_account_id?: string | null
          stripe_connect_account_pending_at?: string | null
          stripe_connect_charges_enabled?: boolean
          stripe_connect_invite_claimed_at?: string | null
          stripe_connect_invite_delivery_ref?: string | null
          stripe_connect_invite_sent_at?: string | null
          stripe_connect_onboarded_at?: string | null
          stripe_connect_token?: string
          stripe_connect_token_expires_at?: string | null
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
      work_order_invoices: {
        Row: {
          created_at: string
          id: string
          invoice_number: string
          org_id: string
          paid_at: string | null
          platform_fee_amount: number
          property_id: string
          status: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          submitted_at: string
          subtotal: number
          total: number
          vendor_id: string
          work_order_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invoice_number: string
          org_id: string
          paid_at?: string | null
          platform_fee_amount?: number
          property_id: string
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          submitted_at?: string
          subtotal?: number
          total?: number
          vendor_id: string
          work_order_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invoice_number?: string
          org_id?: string
          paid_at?: string | null
          platform_fee_amount?: number
          property_id?: string
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          submitted_at?: string
          subtotal?: number
          total?: number
          vendor_id?: string
          work_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_order_invoices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_invoices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_invoices_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendor_compliance_status"
            referencedColumns: ["vendor_id"]
          },
          {
            foreignKeyName: "work_order_invoices_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_order_invoices_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: true
            referencedRelation: "work_orders"
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
          vendor_submitted: boolean
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
          vendor_submitted?: boolean
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
          vendor_submitted?: boolean
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
          client_report_id: string | null
          completed_by_name: string | null
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
          lockbox_code: string | null
          nte_amount: number | null
          org_id: string
          parking_notes: string | null
          portal_enabled: boolean
          priority: Database["public"]["Enums"]["priority_level"]
          property_id: string
          public_signed_off_at: string | null
          public_token: string | null
          public_token_expires_at: string | null
          public_viewed_at: string | null
          reported_by_crew_member_id: string | null
          scheduled_date: string | null
          scheduled_time: string | null
          sign_off_notes: string | null
          source: Database["public"]["Enums"]["wo_source"]
          source_inspection_id: string | null
          source_inspection_item_id: string | null
          source_schedule_id: string | null
          source_turnover_id: string | null
          status: Database["public"]["Enums"]["wo_status"]
          suggested_crew_member_ids: string[] | null
          suggested_vendor_ids: string[] | null
          suggestion_reasoning: string | null
          suggestion_status: string | null
          title: string
          updated_at: string
          vendor_acknowledged_at: string | null
          vendor_acknowledged_by: string | null
          vendor_dispatch_email: string | null
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
          client_report_id?: string | null
          completed_by_name?: string | null
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
          lockbox_code?: string | null
          nte_amount?: number | null
          org_id: string
          parking_notes?: string | null
          portal_enabled?: boolean
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id: string
          public_signed_off_at?: string | null
          public_token?: string | null
          public_token_expires_at?: string | null
          public_viewed_at?: string | null
          reported_by_crew_member_id?: string | null
          scheduled_date?: string | null
          scheduled_time?: string | null
          sign_off_notes?: string | null
          source?: Database["public"]["Enums"]["wo_source"]
          source_inspection_id?: string | null
          source_inspection_item_id?: string | null
          source_schedule_id?: string | null
          source_turnover_id?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          suggested_crew_member_ids?: string[] | null
          suggested_vendor_ids?: string[] | null
          suggestion_reasoning?: string | null
          suggestion_status?: string | null
          title: string
          updated_at?: string
          vendor_acknowledged_at?: string | null
          vendor_acknowledged_by?: string | null
          vendor_dispatch_email?: string | null
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
          client_report_id?: string | null
          completed_by_name?: string | null
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
          lockbox_code?: string | null
          nte_amount?: number | null
          org_id?: string
          parking_notes?: string | null
          portal_enabled?: boolean
          priority?: Database["public"]["Enums"]["priority_level"]
          property_id?: string
          public_signed_off_at?: string | null
          public_token?: string | null
          public_token_expires_at?: string | null
          public_viewed_at?: string | null
          reported_by_crew_member_id?: string | null
          scheduled_date?: string | null
          scheduled_time?: string | null
          sign_off_notes?: string | null
          source?: Database["public"]["Enums"]["wo_source"]
          source_inspection_id?: string | null
          source_inspection_item_id?: string | null
          source_schedule_id?: string | null
          source_turnover_id?: string | null
          status?: Database["public"]["Enums"]["wo_status"]
          suggested_crew_member_ids?: string[] | null
          suggested_vendor_ids?: string[] | null
          suggestion_reasoning?: string | null
          suggestion_status?: string | null
          title?: string
          updated_at?: string
          vendor_acknowledged_at?: string | null
          vendor_acknowledged_by?: string | null
          vendor_dispatch_email?: string | null
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
            foreignKeyName: "work_orders_reported_by_crew_member_id_fkey"
            columns: ["reported_by_crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_source_inspection_id_fkey"
            columns: ["source_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_source_inspection_item_id_fkey"
            columns: ["source_inspection_item_id"]
            isOneToOne: false
            referencedRelation: "inspection_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_source_schedule_id_fkey"
            columns: ["source_schedule_id"]
            isOneToOne: false
            referencedRelation: "maintenance_schedules"
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
          org_onboarding_grace: boolean | null
          org_onboarding_grace_ends_at: string | null
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
      accidental_junction_tables: {
        Args: never
        Returns: {
          junction_table: string
          parents: string[]
          pk_columns: string[]
        }[]
      }
      apply_asset_health_scores: {
        Args: { p_org_id: string; p_updates: Json }
        Returns: number
      }
      apply_crew_score_recompute: { Args: never; Returns: Json }
      apply_inventory_counts: {
        Args: { p_counts: Json; p_org_id: string }
        Returns: number
      }
      apply_resolved_par_levels: { Args: { p_rows: Json }; Returns: number }
      approve_quote_request: {
        Args: {
          p_completion_token: string
          p_org_id: string
          p_quote_request_id: string
          p_token_expires_at: string
        }
        Returns: Json
      }
      claim_hospitable_promo_slot: {
        Args: { p_org_id: string; p_price_cents: number; p_tier: string }
        Returns: {
          already_awarded: boolean
          lock_years: number
          not_eligible: boolean
          sequence_number: number
          window_closed: boolean
        }[]
      }
      claim_pending_integration_link: {
        Args: { p_pending_link_token: string; p_user_id: string }
        Returns: {
          external_user_id: string
          org_id: string
          provider_id: string
        }[]
      }
      claim_pending_oauth_authorization: {
        Args: { p_pending_link_token: string }
        Returns: {
          authorization_code: string
          provider_id: string
          redirect_uri: string
        }[]
      }
      cleanup_expired_oauth_states: { Args: never; Returns: undefined }
      cleanup_expired_pending_integration_links: {
        Args: never
        Returns: undefined
      }
      cleanup_expired_pending_oauth_authorizations: {
        Args: never
        Returns: undefined
      }
      cleanup_webhook_dedup: { Args: never; Returns: undefined }
      clone_inventory_from_property: {
        Args: {
          p_org_id: string
          p_source_property_id: string
          p_target_property_id: string
        }
        Returns: {
          added: number
          skipped: number
          source_count: number
        }[]
      }
      complete_work_order_via_token: {
        Args: {
          p_completed_by_name: string
          p_line_items: Json
          p_notes: string
          p_platform_fee_pct?: number
          p_subtotal: number
          p_work_order_id: string
        }
        Returns: Json
      }
      create_organization_with_owner: {
        Args: {
          p_billing_email: string
          p_max_properties: number
          p_name: string
          p_slug: string
          p_trial_ends_at: string
          p_user_id: string
        }
        Returns: {
          created: boolean
          org_id: string
        }[]
      }
      create_pending_integration_link: {
        Args: {
          p_access_token: string
          p_external_user_id: string
          p_metadata?: Json
          p_pending_link_token: string
          p_provider_id: string
          p_refresh_token?: string
          p_scope?: string
        }
        Returns: string
      }
      create_pending_oauth_authorization: {
        Args: {
          p_authorization_code: string
          p_pending_link_token: string
          p_provider_id: string
          p_redirect_uri: string
        }
        Returns: string
      }
      db_invariant_report: { Args: never; Returns: Json }
      db_narrowed_update_grants: { Args: never; Returns: Json }
      db_type_shape_report: { Args: never; Returns: Json }
      delete_vault_secret: { Args: { p_secret_id: string }; Returns: undefined }
      derive_property_stay_lengths: {
        Args: { p_org_id: string; p_property_ids: string[] }
        Returns: {
          avg_nights: number
          property_id: string
          sample_count: number
        }[]
      }
      disconnect_integration_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: undefined
      }
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
      get_crew_org_ids: { Args: never; Returns: string[] }
      get_crew_property_ids: { Args: never; Returns: string[] }
      get_crew_turnover_ids: { Args: never; Returns: string[] }
      get_repeat_issues: {
        Args: { since_date: string }
        Returns: {
          category: string
          org_id: string
          property_id: string
          wo_count: number
        }[]
      }
      get_system_health: { Args: never; Returns: Json }
      get_user_org_ids: { Args: never; Returns: string[] }
      inventory_below_par_for_org: {
        Args: { p_org_id: string }
        Returns: {
          current_quantity: number
          first_count_recorded_at: string
          id: string
          name: string
          par_level: number
          property_id: string
        }[]
      }
      inventory_below_par_items: {
        Args: { p_org_id: string; p_property_ids?: string[] }
        Returns: {
          current_quantity: number
          first_count_recorded_at: string
          id: string
          name: string
          par_level: number
          preferred_brand: string
          property_id: string
          property_name: string
          property_zip: string
          unit: string
        }[]
      }
      is_org_member: {
        Args: {
          p_org_id: string
          p_roles?: Database["public"]["Enums"]["member_role"][]
        }
        Returns: boolean
      }
      is_platform_staff: { Args: never; Returns: boolean }
      is_platform_staff_admin: { Args: never; Returns: boolean }
      mark_property_setup_step: {
        Args: { p_org_id: string; p_property_id: string; p_step: string }
        Returns: Json
      }
      match_kb_chunks: {
        Args: {
          match_count?: number
          min_similarity?: number
          query_embedding: string
        }
        Returns: {
          content: string
          id: string
          similarity: number
          source: string
          title: string
        }[]
      }
      merge_integration_connection_metadata: {
        Args: {
          p_patch: Json
          p_provider_id: string
          p_status?: string
          p_user_id: string
        }
        Returns: Json
      }
      metrics_inventory_below_par_count: { Args: never; Returns: number }
      metrics_vendor_compliance_counts: {
        Args: never
        Returns: {
          compliance_status: string
          count: number
        }[]
      }
      metrics_work_order_backlog: {
        Args: never
        Returns: {
          count: number
          status: string
        }[]
      }
      migration_ledger_digests: { Args: never; Returns: Json }
      migration_ledger_versions: { Args: never; Returns: Json }
      next_wo_number: { Args: { p_org_id: string }; Returns: string }
      next_work_order_invoice_seq: { Args: never; Returns: number }
      notify_crew_sync: {
        Args: { p_entity: string; p_user_ids: string[] }
        Returns: undefined
      }
      purge_expired_audit_events: { Args: never; Returns: Json }
      read_integration_refresh_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: string
      }
      read_integration_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: string
      }
      read_property_door_code: {
        Args: { p_org_id: string; p_property_id: string }
        Returns: string
      }
      recompute_vendor_scores: { Args: never; Returns: number }
      record_consumption_samples: { Args: { p_rows: Json }; Returns: number }
      record_guidebook_offer_open: {
        Args: { p_booking_id?: string; p_org_id: string; p_sponsor_id: string }
        Returns: undefined
      }
      remove_crew_from_turnover: {
        Args: {
          p_crew_member_id: string
          p_org_id: string
          p_turnover_id: string
        }
        Returns: Json
      }
      replace_platform_inventory_template_items: {
        Args: { p_items: Json; p_template_id: string }
        Returns: number
      }
      replace_property_asset: {
        Args: { p_new_asset: Json; p_old_asset_id: string; p_org_id: string }
        Returns: Json
      }
      replace_room_template_items: {
        Args: { p_items: Json; p_room_template_id: string }
        Returns: number
      }
      replace_seed_room_template_items: {
        Args: { p_items: Json; p_template_id: string }
        Returns: number
      }
      retention_protected_table_violations: {
        Args: never
        Returns: {
          function_name: string
          protected_table: string
        }[]
      }
      revoke_integration_token: {
        Args: { p_provider_id: string; p_user_id: string }
        Returns: undefined
      }
      rls_policy_report: { Args: never; Returns: Json }
      service_role_grant_gaps: {
        Args: never
        Returns: {
          has_authenticated_select: boolean
          kind: string
          relation: string
        }[]
      }
      set_default_platform_inventory_template: {
        Args: { p_template_id: string }
        Returns: undefined
      }
      storage_org_prefix: { Args: { object_name: string }; Returns: string }
      store_integration_refresh_token: {
        Args: {
          p_expires_at?: string
          p_provider_id: string
          p_refresh_token: string
          p_user_id: string
        }
        Returns: string
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
      store_property_door_code: {
        Args: { p_door_code: string; p_org_id: string; p_property_id: string }
        Returns: string
      }
      submit_inspection: {
        Args: {
          p_inspection_id: string
          p_inspector_name: string
          p_items: Json
        }
        Returns: Json
      }
      submit_quote_via_token: {
        Args: {
          p_line_items: Json
          p_max_total?: number
          p_notes: string
          p_quote_token: string
        }
        Returns: Json
      }
      tag_hospitable_trial_signup: {
        Args: { p_landing_page_cookie_present?: boolean; p_org_id: string }
        Returns: undefined
      }
      unique_index_shapes: {
        Args: never
        Returns: {
          has_expression: boolean
          index_name: string
          is_partial: boolean
          key_columns: string[]
          table_name: string
        }[]
      }
      update_organization_subscription_from_stripe: {
        Args: {
          p_customer_id: string
          p_event_at?: string
          p_max_properties: number
          p_plan: Database["public"]["Enums"]["org_plan"]
          p_plan_status: Database["public"]["Enums"]["org_plan_status"]
          p_stripe_subscription_id: string
          p_trial_ends_at: string
        }
        Returns: {
          applied: boolean
          org_id: string
          org_name: string
          previous_plan: Database["public"]["Enums"]["org_plan"]
        }[]
      }
      upsert_default_checklist_template: {
        Args: { p_name: string; p_org_id: string; p_property_id: string }
        Returns: string
      }
      upsert_vendor_by_email: {
        Args: { p_email: string; p_name: string; p_org_id: string }
        Returns: {
          email: string
          id: string
          name: string
          phone: string
        }[]
      }
    }
    Enums: {
      asset_scan_status: "pending" | "processing" | "completed" | "failed"
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
        | "water_shutoff_valve"
        | "solar_inverter"
        | "whole_home_water_filter"
        | "heated_tile_system"
        | "range_hood_vent"
        | "coffee_station"
        | "toaster_oven"
        | "wifi_router"
        | "fire_extinguisher"
        | "thermostat"
        | "ice_maker"
        | "garbage_disposal"
        | "trash_compactor"
      booking_source:
        | "airbnb"
        | "vrbo"
        | "booking_com"
        | "direct"
        | "manual"
        | "other"
        | "ownerrez"
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
      inspection_action: "repair" | "service" | "replace"
      inspection_remediation:
        | "none"
        | "work_order"
        | "purchase_order"
        | "notify"
      inspection_repeat_answer: "same" | "new"
      inspection_response_type: "yes_no" | "count" | "date" | "text" | "photo"
      inspection_result: "pass" | "fail" | "na"
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
      org_plan:
        | "starter"
        | "growth"
        | "pro"
        | "enterprise"
        | "portfolio"
        | "hosts"
      org_plan_status:
        | "trialing"
        | "active"
        | "past_due"
        | "cancelled"
        | "paused"
      par_mode: "static" | "smart"
      par_smart_group:
        | "bathroom_essential"
        | "bedroom_essential"
        | "guest_consumable"
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
      schedule_creates: "work_order" | "inspection"
      schedule_frequency:
        | "weekly"
        | "biweekly"
        | "monthly"
        | "quarterly"
        | "semi_annual"
        | "annual"
      schedule_type: "routine" | "seasonal"
      support_category: "faq" | "technical" | "account_specific"
      support_message_role: "user" | "assistant" | "human"
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
        | "vacancy_gap_suggestion"
        | "inspection"
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
      asset_scan_status: ["pending", "processing", "completed", "failed"],
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
        "water_shutoff_valve",
        "solar_inverter",
        "whole_home_water_filter",
        "heated_tile_system",
        "range_hood_vent",
        "coffee_station",
        "toaster_oven",
        "wifi_router",
        "fire_extinguisher",
        "thermostat",
        "ice_maker",
        "garbage_disposal",
        "trash_compactor",
      ],
      booking_source: [
        "airbnb",
        "vrbo",
        "booking_com",
        "direct",
        "manual",
        "other",
        "ownerrez",
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
      inspection_action: ["repair", "service", "replace"],
      inspection_remediation: [
        "none",
        "work_order",
        "purchase_order",
        "notify",
      ],
      inspection_repeat_answer: ["same", "new"],
      inspection_response_type: ["yes_no", "count", "date", "text", "photo"],
      inspection_result: ["pass", "fail", "na"],
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
      org_plan: [
        "starter",
        "growth",
        "pro",
        "enterprise",
        "portfolio",
        "hosts",
      ],
      org_plan_status: [
        "trialing",
        "active",
        "past_due",
        "cancelled",
        "paused",
      ],
      par_mode: ["static", "smart"],
      par_smart_group: [
        "bathroom_essential",
        "bedroom_essential",
        "guest_consumable",
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
      schedule_creates: ["work_order", "inspection"],
      schedule_frequency: [
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "semi_annual",
        "annual",
      ],
      schedule_type: ["routine", "seasonal"],
      support_category: ["faq", "technical", "account_specific"],
      support_message_role: ["user", "assistant", "human"],
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
        "vacancy_gap_suggestion",
        "inspection",
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
