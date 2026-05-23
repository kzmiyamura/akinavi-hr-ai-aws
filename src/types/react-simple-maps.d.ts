declare module 'react-simple-maps' {
  import type { ReactNode, CSSProperties, MouseEvent } from 'react'

  interface ComposableMapProps {
    projection?: string
    projectionConfig?: Record<string, unknown>
    width?: number
    height?: number
    style?: CSSProperties
    children?: ReactNode
  }
  export function ComposableMap(props: ComposableMapProps): JSX.Element

  interface ZoomableGroupProps {
    center?: [number, number]
    zoom?: number
    children?: ReactNode
  }
  export function ZoomableGroup(props: ZoomableGroupProps): JSX.Element

  interface GeoFeature {
    rsmKey: string
    properties: Record<string, string | number>
  }

  interface GeographiesProps {
    geography: string | object
    children: (args: { geographies: GeoFeature[] }) => ReactNode
  }
  export function Geographies(props: GeographiesProps): JSX.Element

  interface GeographyStyle {
    fill?: string
    stroke?: string
    strokeWidth?: number
    outline?: string
    cursor?: string
  }

  interface GeographyProps {
    geography: GeoFeature
    fill?: string
    stroke?: string
    strokeWidth?: number
    style?: { default?: GeographyStyle; hover?: GeographyStyle; pressed?: GeographyStyle }
    onMouseEnter?: (event: MouseEvent<SVGPathElement>) => void
    onMouseLeave?: (event: MouseEvent<SVGPathElement>) => void
    'data-tooltip-id'?: string
  }
  export function Geography(props: GeographyProps): JSX.Element
}
