'use client'

import { useState, useTransition, useActionState, useRef, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Plus, ChevronDown, X, Wrench, Calendar, DollarSign,
  User, ChevronRight, AlertTriangle, CheckCircle2, Clock,
  Pencil, Trash2, Camera, List, BarChart2, Send, LayoutGrid, Loader2,
} from 'lucide-react'
