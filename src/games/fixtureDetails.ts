import { BoxGeometry, CylinderGeometry, SphereGeometry } from 'three'
import type { SlotWriter } from '../archkit/writer'
import type { ParkMaterials } from '../materials/library'

/** Low-cost joinery shared by Midway counters and service kiosks. */
export function emitCounterJoinery(
  writer: SlotWriter,
  materials: ParkMaterials,
  x: number,
  groundY: number,
  z: number,
  width: number,
  depth: number,
): void {
  const top = new BoxGeometry(width + 0.22, 0.1, depth + 0.2)
  const plinth = new BoxGeometry(width + 0.12, 0.13, depth + 0.1)
  const post = new CylinderGeometry(0.055, 0.075, 0.92, 8)
  const stud = new SphereGeometry(0.075, 8, 6)
  writer.place(materials.brass, top, x, groundY + 0.99, z)
  writer.place(materials.marble, plinth, x, groundY + 0.065, z)
  for (const side of [-1, 1]) {
    for (const face of [-1, 1]) {
      const px = x + side * (width / 2 - 0.08)
      const pz = z + face * (depth / 2 - 0.06)
      writer.place(materials.verdigris, post, px, groundY + 0.52, pz)
      writer.place(materials.nacre, stud, px, groundY + 1.07, pz)
    }
  }
  top.dispose()
  plinth.dispose()
  post.dispose()
  stud.dispose()
}

export function emitBackboardFrame(
  writer: SlotWriter,
  materials: ParkMaterials,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): void {
  const horizontal = new BoxGeometry(width + 0.28, 0.13, 0.18)
  const vertical = new BoxGeometry(0.13, height, 0.18)
  for (const side of [-1, 1]) {
    writer.place(materials.brass, horizontal, x, y + side * height / 2, z)
    writer.place(materials.verdigris, vertical, x + side * width / 2, y, z)
  }
  horizontal.dispose()
  vertical.dispose()
}

export function emitHighStrikerTrim(
  writer: SlotWriter,
  materials: ParkMaterials,
  x: number,
  groundY: number,
  z: number,
): void {
  const foot = new BoxGeometry(2.5, 0.16, 0.72)
  const side = new CylinderGeometry(0.07, 0.09, 6.2, 8)
  writer.place(materials.marble, foot, x, groundY + 0.08, z)
  writer.place(materials.verdigris, side, x - 1, groundY + 3.2, z)
  writer.place(materials.verdigris, side, x + 1, groundY + 3.2, z)
  // Cornice over the tapered tower crown, then the bell yoke: two posts and
  // a crossbar in the bell plane (z − 0.32) that the bell link hangs from.
  const cornice = new BoxGeometry(2.3, 0.14, 0.5)
  writer.place(materials.brass, cornice, x, groundY + 6.38, z)
  const post = new CylinderGeometry(0.05, 0.06, 0.85, 8)
  writer.place(materials.brass, post, x - 0.4, groundY + 6.82, z - 0.32)
  writer.place(materials.brass, post, x + 0.4, groundY + 6.82, z - 0.32)
  const cross = new CylinderGeometry(0.045, 0.045, 0.95, 8)
  cross.rotateZ(Math.PI / 2)
  writer.place(materials.brass, cross, x, groundY + 7.2, z - 0.32)
  const finial = new SphereGeometry(0.075, 10, 8)
  writer.place(materials.brass, finial, x - 0.4, groundY + 7.28, z - 0.32)
  writer.place(materials.brass, finial, x + 0.4, groundY + 7.28, z - 0.32)
  foot.dispose()
  side.dispose()
  cornice.dispose()
  post.dispose()
  cross.dispose()
  finial.dispose()
}
