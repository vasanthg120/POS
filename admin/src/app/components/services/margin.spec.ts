import { TestBed } from '@angular/core/testing';

import { Margin } from './margin';

describe('Margin', () => {
  let service: Margin;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Margin);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
