/**
 * ar.io's full logo, the brand kit's own file unchanged (ar.io/brand/
 * ario-full-white.svg): the light variant, for the deep-dark framed hero the
 * ar.io pages put it on. Do not recolour or redraw it.
 */
import arioFullWhite from './brand/ario-full-white.svg?url';

export function ArioLogo() {
  return <img class="logo" src={arioFullWhite} alt="ar.io" width={1296} height={381} />;
}
