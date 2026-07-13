import './styles.css'
import { isDesktopChromium, showDesktopChromiumGate } from './ui/browserGate'

if (isDesktopChromium()) {
  void import('./main')
} else {
  showDesktopChromiumGate(document.body)
}
