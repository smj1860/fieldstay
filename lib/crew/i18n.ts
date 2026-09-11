import { useCrewContext } from './crew-context'
import type { CrewLocale } from '@/types/database'

/**
 * The crew app's UI-chrome dictionary — nav labels, buttons, static
 * messages. Deliberately a plain object rather than a library like
 * next-intl: the crew app is a closed set of ~27 files, and this codebase
 * favors minimal dependencies (see CLAUDE.md's "Never introduce" list).
 *
 * Scope is deliberately the static chrome a crew member sees everywhere —
 * nav, pill headers, primary buttons, status badges, the sync-failure
 * banner's labels — not every form placeholder or validation message.
 * Content that's per-org or free text (checklist items, inventory names,
 * work order descriptions) is handled separately via _es database columns,
 * not this dictionary — see the tasks tracked alongside this file.
 */
const CREW_DICT = {
  en: {
    language:      'Language',
    languageEn:    'English',
    languageEs:    'Español',

    navAssignments: 'Assignments',
    navAssets:      'Assets',
    navTimeOff:     'Time Off',
    navMessages:    'Messages',
    navHelp:        'Help',

    dashboardWelcomePrefix:       'Welcome,',
    dashboardLoading:             'Loading your assignments…',
    dashboardLoadError:           "Couldn't load your assignments — check your connection and pull to refresh.",
    dashboardCaughtUp:            "You're all caught up — no active assignments.",
    dashboardTodaysTurnovers:     "Today's Turnovers",
    dashboardUpcoming:            'Upcoming',
    dashboardNoTodaysTurnovers:   "No today's turnovers",
    dashboardNoUpcoming:          'No upcoming',
    dashboardSendFeedback:        'Send feedback',
    dashboardTravelTimePrefix:    'Total Travel Time:',
    dashboardTravelTimeUnavailable: 'unavailable',

    feedbackTitle:       'Send feedback',
    feedbackPrompt:      'What would make this app more helpful for your day-to-day work?',
    feedbackPlaceholder: 'Share an idea, a frustration, or anything that would help…',
    feedbackSubmit:      'Submit',
    feedbackSending:     'Sending…',
    feedbackDone:        'Done',
    feedbackThankYou:    'Thank you!',
    feedbackThankYouBody: 'Your feedback goes straight to the team that builds this app.',
    feedbackGenericError: 'Something went wrong',

    statusAssigned:   'Assigned',
    statusInProgress: 'In Progress',
    woBadge:          'WO',
    scheduledPrefix:  'Scheduled',
    propertyFallback: 'Property',

    assetsBack:                   'Back',
    assetsPlaceWorkOrder:         'Place a Work Order',
    assetsAssetDiscovery:         'Asset Discovery',
    assetsCapture:                'Capture',
    assetsEveryAssetDiscovered:   'Every required asset has been discovered.',

    actionSubmit:     'Submit',
    actionSubmitting: 'Submitting…',
    actionSave:       'Save',
    actionSaving:     'Saving…',

    woModalTitlePlaced:      'Work Order Placed',
    woModalPropertyLabel:    'Property',
    woModalAssetLabel:       'Which asset?',
    woModalAssetOther:       'Other / not listed',
    woModalIssueLabel:       "What's the issue? *",
    woModalIssuePlaceholder: 'e.g. Leaking faucet in master bath',
    woModalEmergencyLabel:   'This is an emergency',
    woModalErrorDescribe:    'Please describe the issue.',
    woModalSuccessBody:      'Saved. The property manager will see this as soon as your phone has a connection.',

    discoveryTitleSaved:       'Saved',
    discoveryCapturePrefix:    'Capture:',
    discoveryPhotoLabel:       'Photo of the data plate / sticker (optional)',
    discoveryNotApplicable:    "This property doesn't have one",
    discoveryErrorGeneric:     'Could not save. Check your connection and try again.',
    discoveryErrorRequired:    'Add a make/model, a photo, or mark this as not applicable.',
    discoverySuccessScanQueued: "Asset saved. We're reading the photo now — make and model will fill in automatically in a moment.",
    discoverySuccessSimple:    'Asset details saved.',

    syncChecklistTaskUpdate:       'Checklist task update',
    syncChecklistCompletionConfirm: 'Checklist completion confirmation',
    syncTurnoverUpdate:            'Turnover update',
    syncInventoryCount:            'Inventory count',
    syncWorkOrderRequest:          'Work order request',
    syncApplianceDetails:          'Appliance details',
    syncWorkOrderCompletion:       'Work order completion',
    syncMessageToOps:              'Message to your operations team',
    syncSavedChange:               'Saved change',
    syncPhoto:                     'Photo',
    syncStalledHint: 'Your work is saved on this phone and will keep retrying on its own. '
      + 'If this stays here, move somewhere with better signal before you finish for the day.',
    syncFailedHint: 'This work is saved on your phone but hasn’t reached FieldStay. '
      + 'Tap retry once you have signal.',

    discoveryMake:  'Make',
    discoveryModel: 'Model',

    syncRetryAll:          'Retry all',
    syncRetrying:          'Retrying…',
    syncDiscardTitle:      'Discard this item?',
    syncKeepIt:            'Keep it',
    syncDiscard:           'Discard',
    syncDiscardAriaPrefix: 'Discard',

    offlinePill:              'Offline',
    offlineDialogTitle:       "You're offline",
    offlineGotIt:             'Got it',
    offlineWorkingFromCache:  'Working from cached data',
    offlineBody: 'Your assignments and checklists are saved on your device. '
      + 'You can complete turnovers and check off tasks without a '
      + 'signal — everything syncs automatically when you reconnect.',

    faqTitle:    'FieldStay Crew App — FAQ',
    faqNeedHelp: 'Need help?',

    done: 'Done',
  },
  es: {
    language:      'Idioma',
    languageEn:    'English',
    languageEs:    'Español',

    navAssignments: 'Asignaciones',
    navAssets:      'Bienes',
    navTimeOff:     'Tiempo libre',
    navMessages:    'Mensajes',
    navHelp:        'Ayuda',

    dashboardWelcomePrefix:       'Bienvenido,',
    dashboardLoading:             'Cargando tus asignaciones…',
    dashboardLoadError:           'No se pudieron cargar tus asignaciones — revisa tu conexión y desliza para actualizar.',
    dashboardCaughtUp:            'Estás al día — no tienes asignaciones activas.',
    dashboardTodaysTurnovers:     'Rotaciones de hoy',
    dashboardUpcoming:            'Próximas',
    dashboardNoTodaysTurnovers:   'Sin rotaciones para hoy',
    dashboardNoUpcoming:          'Sin próximas',
    dashboardSendFeedback:        'Enviar comentarios',
    dashboardTravelTimePrefix:    'Tiempo total de viaje:',
    dashboardTravelTimeUnavailable: 'no disponible',

    feedbackTitle:       'Enviar comentarios',
    feedbackPrompt:      '¿Qué haría que esta app fuera más útil para tu trabajo diario?',
    feedbackPlaceholder: 'Comparte una idea, una frustración o cualquier cosa que ayudaría…',
    feedbackSubmit:      'Enviar',
    feedbackSending:     'Enviando…',
    feedbackDone:        'Listo',
    feedbackThankYou:    '¡Gracias!',
    feedbackThankYouBody: 'Tus comentarios van directo al equipo que crea esta app.',
    feedbackGenericError: 'Algo salió mal',

    statusAssigned:   'Asignado',
    statusInProgress: 'En progreso',
    woBadge:          'OT',
    scheduledPrefix:  'Programado',
    propertyFallback: 'Propiedad',

    assetsBack:                   'Atrás',
    assetsPlaceWorkOrder:         'Solicitar una orden de trabajo',
    assetsAssetDiscovery:         'Inventario de bienes',
    assetsCapture:                'Capturar',
    assetsEveryAssetDiscovered:   'Se han registrado todos los bienes requeridos.',

    actionSubmit:     'Enviar',
    actionSubmitting: 'Enviando…',
    actionSave:       'Guardar',
    actionSaving:     'Guardando…',

    woModalTitlePlaced:      'Orden de trabajo enviada',
    woModalPropertyLabel:    'Propiedad',
    woModalAssetLabel:       '¿Qué bien?',
    woModalAssetOther:       'Otro / no está en la lista',
    woModalIssueLabel:       '¿Cuál es el problema? *',
    woModalIssuePlaceholder: 'ej. Grifo con fuga en el baño principal',
    woModalEmergencyLabel:   'Esto es una emergencia',
    woModalErrorDescribe:    'Por favor describe el problema.',
    woModalSuccessBody:      'Guardado. El gerente de la propiedad lo verá en cuanto tu teléfono tenga conexión.',

    discoveryTitleSaved:       'Guardado',
    discoveryCapturePrefix:    'Capturar:',
    discoveryPhotoLabel:       'Foto de la placa de datos / etiqueta (opcional)',
    discoveryNotApplicable:    'Esta propiedad no tiene uno',
    discoveryErrorGeneric:     'No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.',
    discoveryErrorRequired:    'Agrega una marca/modelo, una foto, o márcalo como no aplicable.',
    discoverySuccessScanQueued: 'Bien guardado. Estamos leyendo la foto ahora — la marca y el modelo se completarán automáticamente en un momento.',
    discoverySuccessSimple:    'Detalles del bien guardados.',

    syncChecklistTaskUpdate:       'Actualización de tarea de la lista',
    syncChecklistCompletionConfirm: 'Confirmación de lista completada',
    syncTurnoverUpdate:            'Actualización de rotación',
    syncInventoryCount:            'Conteo de inventario',
    syncWorkOrderRequest:          'Solicitud de orden de trabajo',
    syncApplianceDetails:          'Detalles del electrodoméstico',
    syncWorkOrderCompletion:       'Finalización de orden de trabajo',
    syncMessageToOps:              'Mensaje a tu equipo de operaciones',
    syncSavedChange:               'Cambio guardado',
    syncPhoto:                     'Foto',
    syncStalledHint: 'Tu trabajo está guardado en este teléfono y seguirá intentando enviarse solo. '
      + 'Si esto sigue apareciendo, busca un lugar con mejor señal antes de terminar tu turno.',
    syncFailedHint: 'Este trabajo está guardado en tu teléfono pero no ha llegado a FieldStay. '
      + 'Toca reintentar cuando tengas señal.',

    discoveryMake:  'Marca',
    discoveryModel: 'Modelo',

    syncRetryAll:          'Reintentar todo',
    syncRetrying:          'Reintentando…',
    syncDiscardTitle:      '¿Descartar este elemento?',
    syncKeepIt:            'Conservar',
    syncDiscard:           'Descartar',
    syncDiscardAriaPrefix: 'Descartar',

    offlinePill:              'Sin conexión',
    offlineDialogTitle:       'Estás sin conexión',
    offlineGotIt:             'Entendido',
    offlineWorkingFromCache:  'Trabajando con datos guardados',
    offlineBody: 'Tus asignaciones y listas de verificación están guardadas en tu dispositivo. '
      + 'Puedes completar rotaciones y marcar tareas sin '
      + 'señal — todo se sincroniza automáticamente cuando te reconectas.',

    faqTitle:    'FieldStay Crew App — Preguntas frecuentes',
    faqNeedHelp: '¿Necesitas ayuda?',

    done: 'Listo',
  },
} as const satisfies Record<CrewLocale, Record<string, string>>

export type CrewDictKey = keyof (typeof CREW_DICT)['en']

/** Pure lookup — no fallback needed since both locales carry every key (enforced by the `satisfies` above). */
export function translateCrew(locale: CrewLocale, key: CrewDictKey): string {
  return CREW_DICT[locale][key]
}

export function useCrewT(): (key: CrewDictKey) => string {
  const { crewLocale } = useCrewContext()
  return (key) => translateCrew(crewLocale, key)
}

/**
 * "You have N active assignment(s)." — pluralization and Spanish grammar
 * ("1 asignación activa" vs "2 asignaciones activas") both depend on count,
 * so this can't be a flat dictionary entry.
 */
export function formatActiveAssignments(locale: CrewLocale, count: number): string {
  if (locale === 'es') {
    return count === 1
      ? 'Tienes 1 asignación activa.'
      : `Tienes ${count} asignaciones activas.`
  }
  return count === 1
    ? 'You have 1 active assignment.'
    : `You have ${count} active assignments.`
}

/** "N change(s) still trying to sync" — the sync-failure panel's amber headline. */
export function formatStalledHeadline(locale: CrewLocale, count: number): string {
  if (locale === 'es') {
    return count === 1 ? '1 cambio todavía intentando sincronizarse' : `${count} cambios todavía intentando sincronizarse`
  }
  return `${count} change${count !== 1 ? 's' : ''} still trying to sync`
}

/** "N item(s) didn't sync" — the sync-failure panel's red headline. */
export function formatFailedHeadline(locale: CrewLocale, count: number): string {
  if (locale === 'es') {
    return count === 1 ? '1 elemento no se sincronizó' : `${count} elementos no se sincronizaron`
  }
  return `${count} item${count !== 1 ? 's' : ''} didn’t sync`
}

/** The discard-confirmation dialog's body, naming the item being discarded. */
export function formatDiscardBody(locale: CrewLocale, label: string): string {
  if (locale === 'es') {
    return `“${label}” nunca llegó a FieldStay. Descartarlo lo elimina de este dispositivo de forma permanente.`
  }
  return `“${label}” never reached FieldStay. Discarding removes it from this device for good.`
}
