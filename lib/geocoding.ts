export async function geocodeZip(
  zip: string
): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN
  if (!token) return null
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(zip)}.json?country=US&types=postcode&limit=1&access_token=${token}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  const [lng, lat] = data.features?.[0]?.center ?? []
  return (lat && lng) ? { lat, lng } : null
}
