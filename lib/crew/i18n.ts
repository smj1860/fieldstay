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
 *
 * Keyed by dictionary key first, {en, es} second — not one flat object per
 * locale — so each string's two translations sit on one line next to each
 * other, and so the two locales aren't two structurally-identical blocks of
 * object literals (which static-analysis duplicate-code detectors flag as
 * copy-paste, since they tokenize the shape and not the string content).
 */
const CREW_DICT = {
  language:      { en: 'Language', es: 'Idioma' },
  languageEn:    { en: 'English', es: 'English' },
  languageEs:    { en: 'Español', es: 'Español' },

  navAssignments: { en: 'Assignments', es: 'Asignaciones' },
  navAssets:      { en: 'Assets', es: 'Bienes' },
  navTimeOff:     { en: 'Time Off', es: 'Tiempo libre' },
  navMessages:    { en: 'Messages', es: 'Mensajes' },
  navHelp:        { en: 'Help', es: 'Ayuda' },

  dashboardWelcomePrefix:       { en: 'Welcome,', es: 'Bienvenido,' },
  dashboardLoading:             { en: 'Loading your assignments…', es: 'Cargando tus asignaciones…' },
  dashboardLoadError:           { en: "Couldn't load your assignments — check your connection and pull to refresh.", es: 'No se pudieron cargar tus asignaciones — revisa tu conexión y desliza para actualizar.' },
  dashboardCaughtUp:            { en: "You're all caught up — no active assignments.", es: 'Estás al día — no tienes asignaciones activas.' },
  dashboardTodaysTurnovers:     { en: "Today's Turnovers", es: 'Rotaciones de hoy' },
  dashboardUpcoming:            { en: 'Upcoming', es: 'Próximas' },
  dashboardNoTodaysTurnovers:   { en: "No today's turnovers", es: 'Sin rotaciones para hoy' },
  dashboardNoUpcoming:          { en: 'No upcoming', es: 'Sin próximas' },
  dashboardSendFeedback:        { en: 'Send feedback', es: 'Enviar comentarios' },
  dashboardTravelTimePrefix:    { en: 'Total Travel Time:', es: 'Tiempo total de viaje:' },
  dashboardTravelTimeUnavailable: { en: 'unavailable', es: 'no disponible' },

  feedbackTitle:        { en: 'Send feedback', es: 'Enviar comentarios' },
  feedbackPrompt:       { en: 'What would make this app more helpful for your day-to-day work?', es: '¿Qué haría que esta app fuera más útil para tu trabajo diario?' },
  feedbackPlaceholder:  { en: 'Share an idea, a frustration, or anything that would help…', es: 'Comparte una idea, una frustración o cualquier cosa que ayudaría…' },
  feedbackSubmit:       { en: 'Submit', es: 'Enviar' },
  feedbackSending:      { en: 'Sending…', es: 'Enviando…' },
  feedbackDone:         { en: 'Done', es: 'Listo' },
  feedbackThankYou:     { en: 'Thank you!', es: '¡Gracias!' },
  feedbackThankYouBody: { en: 'Your feedback goes straight to the team that builds this app.', es: 'Tus comentarios van directo al equipo que crea esta app.' },
  feedbackGenericError: { en: 'Something went wrong', es: 'Algo salió mal' },

  statusAssigned:   { en: 'Assigned', es: 'Asignado' },
  statusInProgress: { en: 'In Progress', es: 'En progreso' },
  woBadge:          { en: 'WO', es: 'OT' },
  scheduledPrefix:  { en: 'Scheduled', es: 'Programado' },
  propertyFallback: { en: 'Property', es: 'Propiedad' },

  assetsBack:                 { en: 'Back', es: 'Atrás' },
  assetsPlaceWorkOrder:       { en: 'Place a Work Order', es: 'Solicitar una orden de trabajo' },
  assetsAssetDiscovery:       { en: 'Asset Discovery', es: 'Inventario de bienes' },
  assetsCapture:              { en: 'Capture', es: 'Capturar' },
  assetsEveryAssetDiscovered: { en: 'Every required asset has been discovered.', es: 'Se han registrado todos los bienes requeridos.' },

  actionSubmit:     { en: 'Submit', es: 'Enviar' },
  actionSubmitting: { en: 'Submitting…', es: 'Enviando…' },
  actionSave:       { en: 'Save', es: 'Guardar' },
  actionSaving:     { en: 'Saving…', es: 'Guardando…' },

  woModalTitlePlaced:      { en: 'Work Order Placed', es: 'Orden de trabajo enviada' },
  woModalPropertyLabel:    { en: 'Property', es: 'Propiedad' },
  woModalAssetLabel:       { en: 'Which asset?', es: '¿Qué bien?' },
  woModalAssetOther:       { en: 'Other / not listed', es: 'Otro / no está en la lista' },
  woModalIssueLabel:       { en: "What's the issue? *", es: '¿Cuál es el problema? *' },
  woModalIssuePlaceholder: { en: 'e.g. Leaking faucet in master bath', es: 'ej. Grifo con fuga en el baño principal' },
  woModalEmergencyLabel:   { en: 'This is an emergency', es: 'Esto es una emergencia' },
  woModalErrorDescribe:    { en: 'Please describe the issue.', es: 'Por favor describe el problema.' },
  woModalSuccessBody:      { en: 'Saved. The property manager will see this as soon as your phone has a connection.', es: 'Guardado. El gerente de la propiedad lo verá en cuanto tu teléfono tenga conexión.' },

  discoveryTitleSaved:        { en: 'Saved', es: 'Guardado' },
  discoveryCapturePrefix:     { en: 'Capture:', es: 'Capturar:' },
  discoveryPhotoLabel:        { en: 'Photo of the data plate / sticker (optional)', es: 'Foto de la placa de datos / etiqueta (opcional)' },
  discoveryNotApplicable:     { en: "This property doesn't have one", es: 'Esta propiedad no tiene uno' },
  discoveryErrorGeneric:      { en: 'Could not save. Check your connection and try again.', es: 'No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.' },
  discoveryErrorRequired:     { en: 'Add a make/model, a photo, or mark this as not applicable.', es: 'Agrega una marca/modelo, una foto, o márcalo como no aplicable.' },
  discoverySuccessScanQueued: { en: "Asset saved. We're reading the photo now — make and model will fill in automatically in a moment.", es: 'Bien guardado. Estamos leyendo la foto ahora — la marca y el modelo se completarán automáticamente en un momento.' },
  discoverySuccessSimple:     { en: 'Asset details saved.', es: 'Detalles del bien guardados.' },

  syncChecklistTaskUpdate:         { en: 'Checklist task update', es: 'Actualización de tarea de la lista' },
  syncChecklistCompletionConfirm:  { en: 'Checklist completion confirmation', es: 'Confirmación de lista completada' },
  syncTurnoverUpdate:              { en: 'Turnover update', es: 'Actualización de rotación' },
  syncInventoryCount:              { en: 'Inventory count', es: 'Conteo de inventario' },
  syncWorkOrderRequest:            { en: 'Work order request', es: 'Solicitud de orden de trabajo' },
  syncApplianceDetails:            { en: 'Appliance details', es: 'Detalles del electrodoméstico' },
  syncWorkOrderCompletion:         { en: 'Work order completion', es: 'Finalización de orden de trabajo' },
  syncMessageToOps:                { en: 'Message to your operations team', es: 'Mensaje a tu equipo de operaciones' },
  syncSavedChange:                 { en: 'Saved change', es: 'Cambio guardado' },
  syncPhoto:                       { en: 'Photo', es: 'Foto' },
  syncStalledHint: {
    en: 'Your work is saved on this phone and will keep retrying on its own. '
      + 'If this stays here, move somewhere with better signal before you finish for the day.',
    es: 'Tu trabajo está guardado en este teléfono y seguirá intentando enviarse solo. '
      + 'Si esto sigue apareciendo, busca un lugar con mejor señal antes de terminar tu turno.',
  },
  syncFailedHint: {
    en: 'This work is saved on your phone but hasn’t reached FieldStay. '
      + 'Tap retry once you have signal.',
    es: 'Este trabajo está guardado en tu teléfono pero no ha llegado a FieldStay. '
      + 'Toca reintentar cuando tengas señal.',
  },

  discoveryMake:  { en: 'Make', es: 'Marca' },
  discoveryModel: { en: 'Model', es: 'Modelo' },

  syncRetryAll:          { en: 'Retry all', es: 'Reintentar todo' },
  syncRetrying:          { en: 'Retrying…', es: 'Reintentando…' },
  syncDiscardTitle:      { en: 'Discard this item?', es: '¿Descartar este elemento?' },
  syncKeepIt:            { en: 'Keep it', es: 'Conservar' },
  syncDiscard:           { en: 'Discard', es: 'Descartar' },
  syncDiscardAriaPrefix: { en: 'Discard', es: 'Descartar' },

  offlinePill:             { en: 'Offline', es: 'Sin conexión' },
  offlineDialogTitle:      { en: "You're offline", es: 'Estás sin conexión' },
  offlineGotIt:            { en: 'Got it', es: 'Entendido' },
  offlineWorkingFromCache: { en: 'Working from cached data', es: 'Trabajando con datos guardados' },
  offlineBody: {
    en: 'Your assignments and checklists are saved on your device. '
      + 'You can complete turnovers and check off tasks without a '
      + 'signal — everything syncs automatically when you reconnect.',
    es: 'Tus asignaciones y listas de verificación están guardadas en tu dispositivo. '
      + 'Puedes completar rotaciones y marcar tareas sin '
      + 'señal — todo se sincroniza automáticamente cuando te reconectas.',
  },

  faqTitle:    { en: 'FieldStay Crew App — FAQ', es: 'FieldStay Crew App — Preguntas frecuentes' },
  faqNeedHelp: { en: 'Need help?', es: '¿Necesitas ayuda?' },

  done: { en: 'Done', es: 'Listo' },
} as const satisfies Record<string, Record<CrewLocale, string>>

export type CrewDictKey = keyof typeof CREW_DICT

/** Pure lookup — no fallback needed since every key carries both locales (enforced by the `satisfies` above). */
export function translateCrew(locale: CrewLocale, key: CrewDictKey): string {
  return CREW_DICT[key][locale]
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
