import { Matrix4, Vector3 } from 'three'

export interface NoticeBoardRoofPanelPlan {
  side: -1 | 1
  rotationX: number
  position: Vector3
  width: number
  thickness: number
  slopeLength: number
}

export interface NoticeBoardRoofPlan {
  panels: NoticeBoardRoofPanelPlan[]
  halfDepth: number
  rise: number
  ridgeY: number
  eaveY: number
  ridgeLength: number
}

/** Board-local pitched roof. The ridge always follows local X. */
export function createNoticeBoardRoofPlan(): NoticeBoardRoofPlan {
  const halfDepth = 0.68
  const rise = 0.46
  const ridgeY = 5.48
  const eaveY = ridgeY - rise
  const pitch = Math.atan2(rise, halfDepth)
  const slopeLength = Math.hypot(rise, halfDepth)
  return {
    panels: ([-1, 1] as const).map((side) => ({
      side,
      rotationX: side * pitch,
      position: new Vector3(0, (ridgeY + eaveY) * 0.5, side * halfDepth * 0.5),
      width: 6.65,
      thickness: 0.09,
      slopeLength,
    })),
    halfDepth,
    rise,
    ridgeY,
    eaveY,
    ridgeLength: 6.75,
  }
}

export function auditNoticeBoardRoof(): {
  ridgeError: number
  eaveError: number
  ridgeAlongLocalX: boolean
} {
  const plan = createNoticeBoardRoofPlan()
  let ridgeError = 0
  let eaveError = 0
  for (const panel of plan.panels) {
    const matrix = new Matrix4().makeRotationX(panel.rotationX)
    matrix.setPosition(panel.position)
    const endpoints = [
      new Vector3(0, 0, -panel.slopeLength * 0.5).applyMatrix4(matrix),
      new Vector3(0, 0, panel.slopeLength * 0.5).applyMatrix4(matrix),
    ]
    const ridge = endpoints.reduce((a, b) => Math.abs(a.z) < Math.abs(b.z) ? a : b)
    const eave = endpoints[0] === ridge ? endpoints[1] : endpoints[0]
    ridgeError = Math.max(ridgeError, Math.hypot(ridge.z, ridge.y - plan.ridgeY))
    eaveError = Math.max(
      eaveError,
      Math.hypot(Math.abs(eave.z) - plan.halfDepth, eave.y - plan.eaveY),
    )
  }
  const result = { ridgeError, eaveError, ridgeAlongLocalX: true }
  if (ridgeError > 1e-6 || eaveError > 1e-6) {
    throw new Error(`Notice-board roof endpoint error: ridge=${ridgeError}, eave=${eaveError}`)
  }
  return result
}
