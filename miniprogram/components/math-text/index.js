import { parseMath } from '../../utils/math';

Component({
  properties: {
    value: {
      type: String,
      value: '',
      observer(value) { this.setData({ segments: parseMath(value) }); }
    },
    maxLines: { type: Number, value: 0 },
    truncated: { type: Boolean, value: false }
  },
  data: { segments: [] },
  lifetimes: {
    attached() { this.setData({ segments: parseMath(this.data.value) }); }
  }
});
