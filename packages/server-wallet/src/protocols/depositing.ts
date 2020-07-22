import {right} from 'fp-ts/lib/Either';
import {none} from 'fp-ts/lib/Option';

import {Protocol, ChannelState} from './state';

export const protocol: Protocol<ChannelState> = () => Promise.resolve(right(none));
