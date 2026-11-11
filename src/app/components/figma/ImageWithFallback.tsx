import React, { useEffect, useState } from 'react'

const ERROR_IMG_SRC =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODgiIGhlaWdodD0iODgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgc3Ryb2tlPSIjMDAwIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBvcGFjaXR5PSIuMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIzLjciPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjU2IiBoZWlnaHQ9IjU2IiByeD0iNiIvPjxwYXRoIGQ9Im0xNiA1OCAxNi0xOCAzMiAzMiIvPjxjaXJjbGUgY3g9IjUzIiBjeT0iMzUiIHI9IjciLz48L3N2Zz4KCg=='

type Props = React.ImgHTMLAttributes<HTMLImageElement> & {
  // Local bundled image shown if the primary (usually cloud) source fails.
  fallbackSrc?: string
}

export function ImageWithFallback({ fallbackSrc, ...props }: Props) {
  const [didError, setDidError] = useState(false)
  const [usingFallback, setUsingFallback] = useState(false)

  // Reset when the source changes (hero slider, CMS refresh, etc.).
  useEffect(() => {
    setDidError(false)
    setUsingFallback(false)
  }, [props.src, fallbackSrc])

  const canUseFallback = Boolean(fallbackSrc) && fallbackSrc !== props.src

  const handleError = () => {
    if (canUseFallback && !usingFallback) {
      setUsingFallback(true)
      return
    }
    setDidError(true)
  }

  const { src, alt, style, className, ...rest } = props
  const effectiveSrc = usingFallback ? fallbackSrc : src

  return didError ? (
    <div
      className={`inline-block bg-gray-100 text-center align-middle ${className ?? ''}`}
      style={style}
    >
      <div className="flex items-center justify-center w-full h-full">
        <img src={ERROR_IMG_SRC} alt="Error loading image" {...rest} data-original-url={src} />
      </div>
    </div>
  ) : (
    <img src={effectiveSrc} alt={alt} className={className} style={style} {...rest} onError={handleError} />
  )
}
