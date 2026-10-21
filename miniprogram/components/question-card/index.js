import { subjectName, typeName, dateText } from '../../utils/format';

Component({
  properties: { question: { type: Object, value: {} }, showSimilarity: { type: Boolean, value: false } },
  data: { subjectLabel: '', typeLabel: '', dateLabel: '', stemTruncated: false },
  observers: {
    question(value) {
      this.setData({
        subjectLabel: subjectName(value.subject),
        typeLabel: typeName(value.type),
        dateLabel: dateText(value.created_at),
        stemTruncated: [...String(value.stem || '')].length > 46
      });
    }
  },
  methods: { onTap() { this.triggerEvent('select', { id: this.data.question.id || this.data.question._id }); } }
});
